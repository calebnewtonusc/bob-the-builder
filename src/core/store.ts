/**
 * The surface store. Applies ops, decides when a surface is safe to paint, and
 * refuses to paint before that.
 *
 * Two rules do most of the work:
 *
 *   Root gate. Nothing renders until a `root` op names a component that has
 *   actually arrived. Without it, a surface flashes a half-built tree on its way
 *   to being correct, and users read that flash as a bug rather than as
 *   progress.
 *
 *   Dangling references are normal. A parent may list children that have not
 *   arrived yet. Those ids resolve to a placeholder that is swapped in place
 *   when the real component lands, so the layout never jumps. This is the whole
 *   reason the wire format is a flat map instead of a tree.
 */

import type {
  ComponentId,
  ComponentNode,
  Json,
  Op,
  PropValue,
  Spec,
  SurfaceEvent,
} from "./spec.js";
import { emptySpec, isBinding } from "./spec.js";
import { setAt } from "./pointer.js";
import type { Catalog } from "./catalog.js";
import { isValidId } from "./catalog.js";

export interface StoreOptions {
  catalog: Catalog;
  /**
   * `strict` rejects the surface on an unknown component or a schema failure.
   * `lenient` drops the offending component, warns, and keeps the rest.
   *
   * Default is `lenient`, because one bad node out of thirty should degrade a
   * card rather than blank the screen. Use `strict` in tests and in CI.
   */
  mode?: "strict" | "lenient";
  /** Validate props against the catalog's Zod schemas. Default true. */
  validateProps?: boolean;
  onEvent?: (event: SurfaceEvent) => void;
}

export class SurfaceStore {
  private spec: Spec = emptySpec();
  private readonly catalog: Catalog;
  private readonly mode: "strict" | "lenient";
  private readonly validateProps: boolean;
  private readonly listeners = new Set<(e: SurfaceEvent) => void>();

  private ready = false;
  private failed = false;
  private finished = false;
  /** Ids referenced as children that have not arrived. */
  private pending = new Set<ComponentId>();

  constructor(opts: StoreOptions) {
    this.catalog = opts.catalog;
    this.mode = opts.mode ?? "lenient";
    this.validateProps = opts.validateProps ?? true;
    if (opts.onEvent) this.listeners.add(opts.onEvent);
  }

  subscribe(fn: (e: SurfaceEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: SurfaceEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  private warn(message: string, detail?: unknown): void {
    if (this.mode === "strict") {
      this.failed = true;
      this.emit({ type: "error", message, detail });
    } else {
      this.emit({ type: "warn", message, detail });
    }
  }

  /**
   * Report a problem that happened upstream of the store, such as a line that
   * would not parse. Routed through the same strict/lenient decision as
   * everything else, so the mode means one thing across the whole pipeline.
   */
  report(message: string, detail?: unknown): void {
    this.warn(message, detail);
  }

  get snapshot(): Spec {
    return this.spec;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get pendingIds(): ComponentId[] {
    return [...this.pending];
  }

  /** Apply a batch and emit at most one lifecycle event for the whole batch. */
  apply(ops: Op[]): void {
    if (this.failed || ops.length === 0) return;

    const changed: ComponentId[] = [];
    const pendingBefore = this.pending.size;

    for (const op of ops) {
      if (this.failed) return;
      this.applyOne(op, changed);
    }

    this.recomputePending();

    if (!this.ready && this.spec.root && this.spec.elements[this.spec.root]) {
      this.ready = true;
      this.emit({ type: "ready", spec: this.spec });
      if (this.pending.size > 0) {
        this.emit({ type: "pending", ids: [...this.pending] });
      }
      return;
    }

    if (this.ready && changed.length > 0) {
      this.emit({ type: "patch", spec: this.spec, changed });
      if (this.pending.size !== pendingBefore) {
        this.emit({ type: "pending", ids: [...this.pending] });
      }
    }
  }

  private applyOne(op: Op, changed: ComponentId[]): void {
    switch (op.op) {
      case "component": {
        const { node } = op;
        if (!isValidId(node.id)) {
          this.warn(`Invalid component id ${JSON.stringify(node.id)}`);
          return;
        }
        if (!this.catalog.has(node.type)) {
          this.warn(
            `Unknown component ${JSON.stringify(node.type)}. ` +
              `The catalog has: ${this.catalog.componentNames.join(", ")}`,
            { id: node.id },
          );
          return;
        }
        const validated = this.validateNode(node);
        if (!validated) return;

        // Children already set by an earlier `>` op survive a later `c`, so the
        // model can emit them in either order.
        const existing = this.spec.elements[node.id];
        this.spec.elements[node.id] = {
          ...validated,
          children:
            validated.children.length > 0
              ? validated.children
              : (existing?.children ?? []),
        };
        changed.push(node.id);
        return;
      }

      case "children": {
        const parent = this.spec.elements[op.id];
        const bad = op.children.filter((c) => !isValidId(c));
        if (bad.length > 0) {
          this.warn(`Invalid child ids: ${bad.join(", ")}`, { parent: op.id });
          return;
        }
        if (parent) {
          this.checkComposition(parent.type, op.children, op.id);
          parent.children = op.children;
        } else {
          // Parent has not arrived. Hold the edge so it applies on arrival.
          this.spec.elements[op.id] = {
            id: op.id,
            type: "__pending__",
            props: {},
            children: op.children,
          };
        }
        changed.push(op.id);
        return;
      }

      case "data": {
        try {
          setAt(this.spec.data, op.path, op.value);
        } catch (err) {
          this.warn(`Bad data path ${op.path}`, err);
          return;
        }
        changed.push("__data__");
        return;
      }

      case "root": {
        if (!isValidId(op.id)) {
          this.warn(`Invalid root id ${JSON.stringify(op.id)}`);
          return;
        }
        this.spec.root = op.id;
        changed.push(op.id);
        return;
      }
    }
  }

  /**
   * Validate and, critically, *strip*.
   *
   * The props on a node came from a language model. They are spread onto a React
   * component by the renderer, so an undeclared prop is not a cosmetic problem:
   * `dangerouslySetInnerHTML` arriving in model output and reaching the DOM is a
   * cross-site scripting hole with a straight line from a poisoned tool result
   * to script execution.
   *
   * So the catalog's declared prop names are an allow-list, applied before
   * anything else. Validating and then handing the *original* object onward,
   * which is the obvious way to write this and the way it was written first,
   * looks correct and enforces nothing.
   */
  private validateNode(node: ComponentNode): ComponentNode | null {
    const def = this.catalog.get(node.type);
    if (!def) return node;

    const allowed = this.catalog.propKeys(node.type);

    // Bindings resolve at render time against the data model, so they are held
    // back from schema validation. The schema describes the resolved shape.
    const literal: Record<string, unknown> = {};
    const bound: Record<string, PropValue> = {};
    const rejected: string[] = [];

    for (const [k, v] of Object.entries(node.props)) {
      if (allowed && !allowed.has(k)) {
        rejected.push(k);
        continue;
      }
      if (isBinding(v)) bound[k] = v;
      else literal[k] = v;
    }

    if (rejected.length > 0) {
      this.warn(
        `Dropped undeclared props on ${node.type}#${node.id}: ${rejected.join(", ")}`,
        { component: node.type },
      );
    }

    if (!this.validateProps) {
      return { ...node, props: { ...literal, ...bound } as Record<string, PropValue> };
    }

    const result = def.props.safeParse(literal);

    if (result.success) {
      // Zod strips unknown keys on success, so this is the second line of
      // defence for a schema whose keys could not be read up front.
      return {
        ...node,
        props: { ...(result.data as Record<string, PropValue>), ...bound },
      };
    }

    // A bound prop can satisfy a required field the literal object lacks, so
    // only complain about issues no binding could explain.
    const unexplained = result.error.issues.filter((i) => {
      const key = i.path[0];
      return typeof key !== "string" || !(key in bound);
    });

    if (unexplained.length > 0) {
      const issues = unexplained
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      this.warn(`Props rejected for ${node.type}#${node.id}: ${issues}`);
      return null;
    }

    return { ...node, props: { ...literal, ...bound } as Record<string, PropValue> };
  }

  private checkComposition(
    parentType: string,
    children: ComponentId[],
    parentId: ComponentId,
  ): void {
    const def = this.catalog.get(parentType);
    if (!def || def.children === undefined) return;
    for (const childId of children) {
      const child = this.spec.elements[childId];
      if (!child || child.type === "__pending__") continue;
      if (!this.catalog.allowsChild(parentType, child.type)) {
        this.warn(
          `${parentType} does not allow ${child.type} as a child`,
          { parent: parentId, child: childId },
        );
      }
    }
  }

  private recomputePending(): void {
    const next = new Set<ComponentId>();
    for (const node of Object.values(this.spec.elements)) {
      for (const childId of node.children) {
        const child = this.spec.elements[childId];
        if (!child || child.type === "__pending__") next.add(childId);
      }
    }
    if (this.spec.root && !this.spec.elements[this.spec.root]) {
      next.add(this.spec.root);
    }
    this.pending = next;
  }

  /**
   * Resolve the render order from the root, skipping unresolved ids and cutting
   * cycles. A model that emits `a > b > a` should degrade to a shallow tree, not
   * hang the renderer.
   */
  resolve(): { order: ComponentId[]; cycles: ComponentId[] } {
    const order: ComponentId[] = [];
    const cycles: ComponentId[] = [];
    if (!this.spec.root) return { order, cycles };

    const onPath = new Set<ComponentId>();
    const visited = new Set<ComponentId>();

    const walk = (id: ComponentId): void => {
      if (onPath.has(id)) {
        cycles.push(id);
        return;
      }
      const node = this.spec.elements[id];
      if (!node || node.type === "__pending__") return;
      if (visited.has(id)) return;
      visited.add(id);
      onPath.add(id);
      order.push(id);
      for (const child of node.children) walk(child);
      onPath.delete(id);
    };

    walk(this.spec.root);
    return { order, cycles };
  }

  finish(): void {
    if (this.failed || this.finished) return;
    this.finished = true;
    if (!this.ready) {
      this.emit({
        type: "error",
        message:
          this.spec.root === null
            ? "Stream ended without a root. Nothing was rendered."
            : `Stream ended before root ${JSON.stringify(this.spec.root)} arrived.`,
      });
      this.failed = true;
      return;
    }
    if (this.pending.size > 0) {
      this.emit({
        type: "warn",
        message: `Stream ended with unresolved children: ${[...this.pending].join(", ")}`,
      });
    }
    this.emit({ type: "done", spec: this.spec });
  }

  /** Write a value back into the data model, from a bound input. */
  write(path: string, value: Json | undefined): void {
    try {
      setAt(this.spec.data, path, value);
      this.recomputePending();
      this.emit({ type: "patch", spec: this.spec, changed: ["__data__"] });
    } catch (err) {
      this.warn(`Could not write to ${path}`, err);
    }
  }
}
