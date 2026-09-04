/**
 * The public streaming entry point. Feed it text chunks from any model or
 * transport; it feeds the store, which decides what is safe to paint.
 *
 * Three wire formats, one store behind all of them:
 *
 *   lines  Bob Lines. Cheapest in tokens, and incrementally safe by
 *          construction because a line is either complete or invisible.
 *   jsonl  One JSON op per line. More verbose, still line-safe, and the right
 *          choice when something downstream already speaks JSON objects.
 *   json   A single streamed Spec object, repaired on every chunk by the
 *          partial parser. Use when the model is pinned to a JSON schema by
 *          structured-output constraints and cannot emit anything else.
 */

import type { ComponentNode, Computed, Json, Op, PropValue, Spec, SurfaceEvent } from "./spec.js";
import { isBinding, isComputed } from "./spec.js";
import { LineBuffer } from "./lines.js";
import { PartialJsonStream } from "./partial.js";
import { SurfaceStore, type StoreOptions } from "./store.js";
import { getAt } from "./pointer.js";

export type WireFormat = "lines" | "jsonl" | "json";

export interface BobStreamOptions extends StoreOptions {
  format?: WireFormat;
}

export class BobStream {
  readonly store: SurfaceStore;
  private readonly format: WireFormat;
  private readonly lineBuf: LineBuffer;
  private readonly jsonBuf = new PartialJsonStream<Partial<Spec>>();
  /** Last spec seen in `json` mode, for diffing one chunk to the next. */
  private lastJson: Partial<Spec> = {};
  private closed = false;

  constructor(opts: BobStreamOptions) {
    this.format = opts.format ?? "lines";
    this.store = new SurfaceStore(opts);
    // A malformed line goes to the store's own warning path rather than
    // throwing, so one bad line degrades a card instead of killing the surface.
    // Strict mode still fails the surface, because the store decides that.
    this.lineBuf = new LineBuffer({
      onError: (err) => this.store.report(err.message, { line: err.line }),
    });
  }

  subscribe(fn: (e: SurfaceEvent) => void): () => void {
    return this.store.subscribe(fn);
  }

  push(chunk: string): void {
    if (this.closed) return;
    switch (this.format) {
      case "lines":
        this.store.apply(this.lineBuf.push(chunk));
        return;
      case "jsonl":
        this.store.apply(this.pushJsonl(chunk));
        return;
      case "json":
        this.store.apply(this.pushJson(chunk));
        return;
    }
  }

  /** Consume a whole async iterable of chunks, then close. */
  async consume(source: AsyncIterable<string>): Promise<Spec> {
    for await (const chunk of source) this.push(chunk);
    this.close();
    return this.store.snapshot;
  }

  close(): void {
    if (this.closed) return;
    if (this.format === "lines") {
      this.store.apply(this.lineBuf.flush());
    } else if (this.format === "jsonl") {
      // Both line formats buffer a trailing line with no newline. Forgetting
      // this for jsonl silently dropped the final op, which is usually `root`.
      this.store.apply(this.flushJsonl());
    }
    this.closed = true;
    this.store.finish();
  }

  private flushJsonl(): Op[] {
    const rest = this.lineBuf.pending;
    this.lineBuf.flushRaw();
    return rest.trim() ? this.parseJsonlLines([rest]) : [];
  }

  private pushJsonl(chunk: string): Op[] {
    // Reuse the line splitter for framing, then parse each line as an op object.
    return this.parseJsonlLines(this.lineBuf.pushRaw(chunk));
  }

  private parseJsonlLines(lines: string[]): Op[] {
    const ops: Op[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      try {
        ops.push(JSON.parse(trimmed) as Op);
      } catch {
        // Reported rather than silently swallowed, so a model emitting prose in
        // a JSONL stream is visible instead of producing an empty surface.
        this.store.report(`Line is not valid JSON: ${trimmed.slice(0, 80)}`);
      }
    }
    return ops;
  }

  private pushJson(chunk: string): Op[] {
    const { value } = this.jsonBuf.push(chunk);
    if (!value) return [];
    const ops = diffSpec(this.lastJson, value);
    this.lastJson = structuredClone(value);
    return ops;
  }
}

/**
 * Turn "the spec now looks like this" into "here is what changed".
 *
 * Needed only in `json` mode, where each chunk hands back a whole re-parsed
 * document instead of a delta. Comparing serialised nodes is cheap at UI sizes
 * and avoids re-rendering every component on every token.
 */
function diffSpec(prev: Partial<Spec>, next: Partial<Spec>): Op[] {
  const ops: Op[] = [];

  const prevEls = prev.elements ?? {};
  const nextEls = next.elements ?? {};

  for (const [id, node] of Object.entries(nextEls)) {
    if (!node || typeof node !== "object" || !node.type) continue;
    const before = prevEls[id];
    const normalized: ComponentNode = {
      id,
      type: node.type,
      props: node.props ?? {},
      children: node.children ?? [],
    };
    if (!before || JSON.stringify(before) !== JSON.stringify(normalized)) {
      ops.push({ op: "component", node: normalized });
      if (normalized.children.length > 0) {
        ops.push({ op: "children", id, children: normalized.children });
      }
    }
  }

  if (next.data) {
    for (const [key, value] of Object.entries(next.data)) {
      const before = prev.data?.[key];
      if (JSON.stringify(before) !== JSON.stringify(value)) {
        ops.push({ op: "data", path: `/${key}`, value: value as Json });
      }
    }
  }

  if (next.root && next.root !== prev.root) {
    ops.push({ op: "root", id: next.root });
  }

  return ops;
}

/**
 * Resolve `$bind` props against the data model. Call at render time, not at
 * parse time, so a data patch updates a component without rebuilding it.
 */
export function resolveProps(
  props: Record<string, PropValue>,
  data: Record<string, Json>,
): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(props)) {
    if (isBinding(value)) {
      const resolved = getAt(data, value.$bind);
      if (resolved !== undefined) out[key] = resolved;
    } else if (isComputed(value)) {
      out[key] = compute(value, data);
    } else {
      out[key] = value as Json;
    }
  }
  return out;
}

/** Evaluate a derived prop. Returns 0 rather than undefined for a missing path,
 *  because "no applications yet" should read as zero, not as a blank. */
function compute(expr: Computed, data: Record<string, Json>): number {
  if ("$count" in expr) {
    const rows = getAt(data, expr.$count);
    if (!Array.isArray(rows)) return 0;
    if (!expr.where) return rows.length;
    const { field, equals } = expr.where;
    return rows.filter(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        !Array.isArray(row) &&
        (row as Record<string, Json>)[field] === equals,
    ).length;
  }

  const rows = getAt(data, expr.$sum);
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const v = (row as Record<string, Json>)[expr.field];
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  return total;
}
