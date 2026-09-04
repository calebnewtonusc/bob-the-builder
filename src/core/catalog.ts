/**
 * The catalog is the toolbox: the complete set of parts Bob is allowed to build
 * with. Nothing outside it can reach the screen.
 *
 * A catalog entry carries more than a props schema. It also declares the things
 * that are impossible to recover later, once a model is emitting specs at
 * runtime:
 *
 *   - `a11y`      where the accessible name comes from, so `bob audit` can
 *                 check a component once instead of auditing generated output
 *                 forever. This is the one real leverage point: a catalog is
 *                 finite, generated HTML is not.
 *   - `skeleton`  what to draw while the component's own props are still
 *                 arriving. Declared alongside the component so the placeholder
 *                 and the real thing share a typeface and a measure, which is
 *                 what stops first-token from reading as a page reload.
 *   - `describe`  one line for the system prompt. The model picks components by
 *                 this text, so it is functional, not documentation.
 */

import type { z } from "zod";
import type { ComponentId } from "./spec.js";

/** How a component exposes its accessible name. */
export type A11yName =
  /** The named prop is the accessible name. */
  | { from: "prop"; prop: string }
  /** Text children provide the name. */
  | { from: "children" }
  /** Decorative: correctly has no accessible name. */
  | { from: "none" };

export interface A11ySpec {
  /**
   * ARIA role this component renders with. `audit` uses it to decide which
   * rules apply, so declare the role you actually render, not the one you meant.
   */
  role?: string;
  /** Where the accessible name comes from. Required for interactive roles. */
  name: A11yName;
  /**
   * True if a keyboard user can reach and operate it. Interactive roles that
   * declare `false` fail the audit.
   */
  keyboard?: boolean;
  /**
   * Announce changes to this component's content through the live region.
   * Use for status, results, and validation, not for decorative motion.
   */
  live?: "polite" | "assertive";
}

export interface SkeletonSpec {
  /**
   * Shape of the placeholder. `text` reserves line boxes at the component's own
   * type scale; `block` reserves a box; `none` renders nothing (correct for
   * containers, which have no ink of their own).
   */
  shape: "text" | "block" | "none";
  /** Lines to reserve when `shape` is `text`. */
  lines?: number;
}

export interface ComponentDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Props schema. Doubles as the contract sent to the model and the runtime guard. */
  props: S;
  /** One line, written for the model. What is this for, and when should it be picked. */
  describe: string;
  a11y: A11ySpec;
  skeleton?: SkeletonSpec;
  /** Component names allowed as children. Omit to allow any. Empty array means leaf. */
  children?: string[];
  /** Short examples that go in the prompt. Two good ones beat ten mediocre. */
  examples?: string[];
}

export interface ActionDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  payload?: S;
  describe: string;
}

/** A map of component name to definition, as written in a catalog. */
export type ComponentDefs = Record<string, ComponentDef>;

/**
 * Recover the prop type of a component definition.
 *
 * This is what lets `ComponentMap` type each React component against the schema
 * its catalog entry declared, instead of every component receiving an untyped
 * bag. Without it a typo in a prop name is only caught at runtime, by the store,
 * on a machine that is not the author's.
 */
export type PropsOf<D> = D extends ComponentDef<infer S> ? z.infer<S> : never;

export interface CatalogInit<C extends ComponentDefs = ComponentDefs> {
  name: string;
  components: C;
  actions?: Record<string, ActionDef>;
  /** Extra guidance appended to the generated system prompt. */
  guidance?: string;
}

export interface Catalog<C extends ComponentDefs = ComponentDefs>
  extends CatalogInit<C> {
  actions: Record<string, ActionDef>;
  componentNames: string[];
  actionNames: string[];
  has(type: string): boolean;
  hasAction(name: string): boolean;
  get(type: string): ComponentDef | undefined;
  /** True if `child` is allowed inside `parent` per the catalog's own rules. */
  allowsChild(parent: string, child: string): boolean;
  /**
   * The prop names a component declares, or null when the schema could not be
   * introspected. The store uses this as an allow-list, so a prop the catalog
   * never declared cannot reach a React component.
   */
  propKeys(type: string): ReadonlySet<string> | null;
}

/**
 * `__`-prefixed ids are reserved for internal sentinels, so a model cannot emit
 * a component named `__pending__` and collide with the placeholder the store
 * uses for an unresolved child.
 */
const ID_RE = /^(?!__)[A-Za-z0-9_-]{1,64}$/;

export function isValidId(id: string): id is ComponentId {
  return ID_RE.test(id);
}

/**
 * Read the top-level keys off a Zod object schema.
 *
 * Zod's internals are not a public API and differ between v3 and v4, so this
 * returns null rather than throwing when it cannot read the shape. A null
 * result makes the store fall back to Zod's own stripping, which is correct but
 * only applies when validation succeeds.
 */
function readPropKeys(schema: z.ZodTypeAny): ReadonlySet<string> | null {
  const shapeSrc = (schema as unknown as { _def?: Record<string, unknown> })._def?.[
    "shape"
  ];
  const shape =
    typeof shapeSrc === "function"
      ? (shapeSrc as () => Record<string, unknown>)()
      : (shapeSrc as Record<string, unknown> | undefined);
  return shape ? new Set(Object.keys(shape)) : null;
}

export function defineComponent<S extends z.ZodTypeAny>(
  def: ComponentDef<S>,
): ComponentDef<S> {
  return def;
}

export function defineAction<S extends z.ZodTypeAny>(
  def: ActionDef<S>,
): ActionDef<S> {
  return def;
}

export function defineCatalog<const C extends ComponentDefs>(
  init: CatalogInit<C>,
): Catalog<C> {
  const actions = init.actions ?? {};
  const componentNames = Object.keys(init.components).sort();
  const actionNames = Object.keys(actions).sort();

  for (const name of componentNames) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
      throw new Error(
        `Component name ${JSON.stringify(name)} must be PascalCase. ` +
          `The model uses casing to tell components from props.`,
      );
    }
    const def = init.components[name]!;
    for (const child of def.children ?? []) {
      if (!(child in init.components)) {
        throw new Error(
          `Component ${name} allows child ${JSON.stringify(child)}, ` +
            `which is not in the catalog.`,
        );
      }
    }
  }

  const propKeyCache = new Map<string, ReadonlySet<string> | null>();
  for (const name of componentNames) {
    propKeyCache.set(name, readPropKeys(init.components[name]!.props));
  }

  return {
    ...init,
    actions,
    componentNames,
    actionNames,
    has: (type) => type in init.components,
    hasAction: (name) => name in actions,
    get: (type) => init.components[type],
    allowsChild(parent, child) {
      const def = init.components[parent];
      if (!def) return false;
      if (def.children === undefined) return true;
      return def.children.includes(child);
    },
    propKeys: (type) => propKeyCache.get(type) ?? null,
  };
}
