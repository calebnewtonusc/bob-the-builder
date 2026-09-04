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

export function parsePointer(pointer: Pointer): string[] {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(
      `Invalid JSON Pointer ${JSON.stringify(pointer)}: must start with "/"`,
    );
  }
  return pointer.slice(1).split("/").map(decodeSegment);
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
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0) {
        throw new Error(
          `Cannot use ${JSON.stringify(seg)} as an array index in ${pointer}`,
        );
      }
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
    } else {
      throw new Error(`Cannot descend through a scalar at ${pointer}`);
    }
  }

  const last = segments[segments.length - 1]!;
  if (Array.isArray(cur)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0) {
      throw new Error(
        `Cannot use ${JSON.stringify(last)} as an array index in ${pointer}`,
      );
    }
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
