/**
 * The wire shape.
 *
 * Components live in a flat map keyed by id, with a named root. They are not a
 * nested tree. Google's A2UI and Vercel's json-render were built independently
 * and both landed here, for the same reason: a nested tree cannot be patched or
 * streamed out of order, and a flat map can. A child may arrive before its
 * parent, a parent before its children, and neither case needs special handling.
 *
 * Data lives separately from components, addressed by JSON Pointer (RFC 6901),
 * so a value can change without touching the component graph and a component can
 * be replaced without losing its value.
 */

/** A component id. One path segment: letters, digits, `_`, `-`. */
export type ComponentId = string;

/** A JSON Pointer into the surface data model, e.g. `/report/rows/0/total`. */
export type Pointer = string;

/** Any value the model can put in a prop or the data model. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/**
 * A prop value that reads from the data model instead of being literal.
 * Input components write back through the same pointer.
 */
export interface Binding {
  $bind: Pointer;
}

export type PropValue = Json | Binding | Computed;

export function isBinding(v: unknown): v is Binding {
  return (
    typeof v === "object" &&
    v !== null &&
    "$bind" in v &&
    typeof (v as Binding).$bind === "string"
  );
}

/**
 * A prop derived from the data rather than read out of it.
 *
 * Three forms, and each one earned its place by a model reaching for it. An app
 * that tracks anything wants "how many" and "how much"; the first live run
 * against a real model added "average rating" to a book tracker unprompted, so
 * $avg is here too.
 *
 * Every additional operator is a small expression language that has to be
 * authored correctly by a model, understood by a reader, and kept safe, so the
 * bar for a fourth is watching a model want it. Anything more complicated
 * belongs in the data.
 */
export type Computed =
  | { $count: Pointer; where?: { field: string; equals: Json } }
  | { $sum: Pointer; field: string }
  | { $avg: Pointer; field: string };

export function isComputed(v: unknown): v is Computed {
  if (typeof v !== "object" || v === null) return false;
  return "$count" in v || "$sum" in v || "$avg" in v;
}

export interface ComponentNode {
  id: ComponentId;
  /** Component name, must exist in the catalog. */
  type: string;
  props: Record<string, PropValue>;
  /** Ordered child ids. May reference ids that have not arrived yet. */
  children: ComponentId[];
}

/** A complete surface at a point in time. */
export interface Spec {
  root: ComponentId | null;
  elements: Record<ComponentId, ComponentNode>;
  data: Record<string, Json>;
}

export function emptySpec(): Spec {
  return { root: null, elements: {}, data: {} };
}

/* -------------------------------------------------------------------------- */
/* Stream operations                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The four things a model can say. Deliberately small: every generative UI
 * protocol surveyed reduces to these, and a fifth op is usually a sign the
 * catalog should have absorbed the behaviour instead.
 */
export type Op =
  | { op: "component"; node: ComponentNode }
  | { op: "children"; id: ComponentId; children: ComponentId[] }
  | { op: "data"; path: Pointer; value: Json | undefined }
  | { op: "root"; id: ComponentId };

/** Emitted by the store as a surface assembles. */
export type SurfaceEvent =
  /** Root arrived and resolves. Nothing should render before this. */
  | { type: "ready"; spec: Spec }
  /** The graph or data changed after ready. */
  | { type: "patch"; spec: Spec; changed: ComponentId[] }
  /** A child id was referenced that has not arrived. Render a placeholder. */
  | { type: "pending"; ids: ComponentId[] }
  /** The stream ended cleanly. */
  | { type: "done"; spec: Spec }
  /** Recoverable problem. The surface keeps going. */
  | { type: "warn"; message: string; detail?: unknown }
  /** Unrecoverable. The surface is abandoned. */
  | { type: "error"; message: string; detail?: unknown };
