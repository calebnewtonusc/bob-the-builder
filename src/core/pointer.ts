/**
 * JSON Pointer (RFC 6901), the subset a UI data model actually needs.
 *
 * Kept in-repo rather than pulled from a dependency because the escaping rules
 * are twelve lines and a transitive dep in the render path is not worth it.
 */

import type { Json, Pointer } from "./spec.js";

/** `~1` is `/` and `~0` is `~`. Order matters: `~0` last when decoding. */
function decodeSegment(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

function encodeSegment(seg: string): string {
  return seg.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Largest array index a data patch may create.
 *
 * Without this, `d /rows/5000000/x 1` allocates a five-million-element array in
 * under a millisecond, from one line of model output. That is a denial of
 * service reachable by anything that can influence what the model writes, which
 * for a tool-using agent includes the contents of a document it just read. No
 * real interface has a five-millionth row.
 */
export const MAX_ARRAY_INDEX = 10_000;

/** Deepest a pointer may go, to bound the work a single patch can cause. */
export const MAX_POINTER_DEPTH = 32;

export function parsePointer(pointer: Pointer): string[] {
  // Deliberate deviation from RFC 6901: there, "/" points at a member whose key
  // is the empty string. Here it means the root, because a model writing `d /`
  // means "the whole data model" every time and never means "the member named
  // empty string", which no real interface has.
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(
      `Invalid JSON Pointer ${JSON.stringify(pointer)}: must start with "/"`,
    );
  }
  const segments = pointer.slice(1).split("/").map(decodeSegment);
  if (segments.length > MAX_POINTER_DEPTH) {
    throw new Error(
      `JSON Pointer ${JSON.stringify(pointer)} is ${segments.length} levels deep, ` +
        `over the limit of ${MAX_POINTER_DEPTH}.`,
    );
  }
  return segments;
}

/** Reject an array index that is negative, fractional, or absurdly large. */
function checkIndex(raw: string, pointer: Pointer): number {
  const idx = Number(raw);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error(
      `Cannot use ${JSON.stringify(raw)} as an array index in ${pointer}`,
    );
  }
  if (idx > MAX_ARRAY_INDEX) {
    throw new Error(
      `Array index ${idx} in ${pointer} is over the limit of ${MAX_ARRAY_INDEX}. ` +
        `Creating it would allocate ${idx + 1} entries from one patch.`,
    );
  }
  return idx;
}

export function formatPointer(segments: string[]): Pointer {
  if (segments.length === 0) return "";
  return "/" + segments.map(encodeSegment).join("/");
}

export function getAt(root: unknown, pointer: Pointer): Json | undefined {
  const segments = parsePointer(pointer);
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur as Json | undefined;
}

/**
 * Upsert semantics, matching A2UI: create the path if missing, replace if
 * present, and delete when `value` is `undefined`. Intermediate containers are
 * created as arrays when the next segment is a non-negative integer, objects
 * otherwise, so `/rows/0/total` builds `{rows: [{total: …}]}` rather than
 * `{rows: {"0": {total: …}}}`.
 *
 * Mutates in place and returns the root, so a store can apply many patches
 * without reallocating the model on every token.
 */
export function setAt(
  root: Record<string, Json>,
  pointer: Pointer,
  value: Json | undefined,
): Record<string, Json> {
  const segments = parsePointer(pointer);

  if (segments.length === 0) {
    if (value === undefined) {
      for (const k of Object.keys(root)) delete root[k];
      return root;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Cannot replace the data model root with a non-object");
    }
    for (const k of Object.keys(root)) delete root[k];
    Object.assign(root, value);
    return root;
  }

  let cur: Json = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = segments[i + 1]!;
    const wantsArray = /^\d+$/.test(next);

    if (Array.isArray(cur)) {
      const idx = checkIndex(seg, pointer);
      const existing = cur[idx];
      if (existing === undefined || existing === null || typeof existing !== "object") {
        cur[idx] = wantsArray ? [] : {};
      }
      cur = cur[idx] as Json;
    } else if (typeof cur === "object" && cur !== null) {
      const obj = cur as Record<string, Json>;
      const existing = obj[seg];
      if (existing === undefined || existing === null || typeof existing !== "object") {
        obj[seg] = wantsArray ? [] : {};
      }
      cur = obj[seg] as Json;
    }
    // No else: a scalar in the path is replaced by a container above, so this
    // branch was unreachable. Upsert means `d /a/b 1` after `d /a 1` widens `a`
    // into an object rather than failing, which is what a model streaming a
    // structure top-down actually needs.
  }

  const last = segments[segments.length - 1]!;
  if (Array.isArray(cur)) {
    const idx = checkIndex(last, pointer);
    if (value === undefined) cur.splice(idx, 1);
    else cur[idx] = value;
  } else if (typeof cur === "object" && cur !== null) {
    const obj = cur as Record<string, Json>;
    if (value === undefined) delete obj[last];
    else obj[last] = value;
  } else {
    throw new Error(`Cannot write through a scalar at ${pointer}`);
  }

  return root;
}
