/**
 * Regressions for the bugs found auditing the first cut. Every test here failed
 * before the fix that follows it, so this file is the audit's receipt.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineComponent } from "../src/core/catalog.js";
import { SurfaceStore } from "../src/core/store.js";
import { BobStream } from "../src/core/stream.js";
import { setAt, MAX_ARRAY_INDEX, MAX_POINTER_DEPTH } from "../src/core/pointer.js";
import type { Json, SurfaceEvent } from "../src/core/spec.js";

const catalog = defineCatalog({
  name: "sec",
  components: {
    Text: defineComponent({
      props: z.object({ value: z.string() }),
      describe: "A paragraph of prose content.",
      a11y: { name: { from: "children" } },
      skeleton: { shape: "text", lines: 1 },
    }),
  },
});

function events(): { seen: SurfaceEvent[]; onEvent: (e: SurfaceEvent) => void } {
  const seen: SurfaceEvent[] = [];
  return { seen, onEvent: (e) => seen.push(e) };
}

describe("prop allow-listing", () => {
  /**
   * The worst bug in the first cut. Props are spread onto a React component by
   * the renderer, and validation ran but its stripped output was discarded, so
   * anything the model invented flowed straight through. A poisoned tool result
   * could put `dangerouslySetInnerHTML` in model output and reach the DOM.
   */
  it("drops a prop the catalog never declared", () => {
    const { seen, onEvent } = events();
    const store = new SurfaceStore({ catalog, onEvent });
    store.apply([
      {
        op: "component",
        node: {
          id: "a",
          type: "Text",
          props: {
            value: "hello",
            dangerouslySetInnerHTML: { __html: "<script>x</script>" } as unknown as Json,
          },
          children: [],
        },
      },
    ]);
    const props = store.snapshot.elements["a"]!.props;
    expect(props).toEqual({ value: "hello" });
    expect(props).not.toHaveProperty("dangerouslySetInnerHTML");
    expect(seen.some((e) => e.type === "warn" && /undeclared/.test(e.message))).toBe(true);
  });

  it("drops event-handler-shaped props", () => {
    const store = new SurfaceStore({ catalog });
    store.apply([
      {
        op: "component",
        node: {
          id: "a",
          type: "Text",
          props: { value: "ok", onClick: "alert(1)", style: "x" },
          children: [],
        },
      },
    ]);
    expect(store.snapshot.elements["a"]!.props).toEqual({ value: "ok" });
  });

  it("keeps a declared prop that is bound to the data model", () => {
    const store = new SurfaceStore({ catalog });
    store.apply([
      {
        op: "component",
        node: { id: "a", type: "Text", props: { value: { $bind: "/m" } }, children: [] },
      },
    ]);
    expect(store.snapshot.elements["a"]!.props).toEqual({ value: { $bind: "/m" } });
  });

  it("still strips when validateProps is off", () => {
    const store = new SurfaceStore({ catalog, validateProps: false });
    store.apply([
      {
        op: "component",
        node: { id: "a", type: "Text", props: { value: "ok", evil: 1 }, children: [] },
      },
    ]);
    expect(store.snapshot.elements["a"]!.props).toEqual({ value: "ok" });
  });
});

describe("reserved ids", () => {
  it("rejects an id that would collide with an internal sentinel", () => {
    const { seen, onEvent } = events();
    const store = new SurfaceStore({ catalog, onEvent });
    store.apply([
      {
        op: "component",
        node: { id: "__pending__", type: "Text", props: { value: "x" }, children: [] },
      },
    ]);
    expect(store.snapshot.elements["__pending__"]).toBeUndefined();
    expect(seen.some((e) => e.type === "warn")).toBe(true);
  });
});

describe("data model resource limits", () => {
  /**
   * `d /rows/5000000/x 1` allocated a five-million-entry array in under a
   * millisecond, from one line of model output. That is a denial of service
   * reachable by anything that can influence what the model writes.
   */
  it("refuses an array index that would allocate an enormous array", () => {
    expect(() => setAt({}, "/rows/5000000/x", 1)).toThrow(/over the limit/);
  });

  it("allows an index at the limit", () => {
    const root: Record<string, Json> = {};
    expect(() => setAt(root, `/rows/${MAX_ARRAY_INDEX}`, 1)).not.toThrow();
  });

  it("refuses an absurdly deep pointer", () => {
    const deep = "/" + Array.from({ length: MAX_POINTER_DEPTH + 5 }, (_, i) => `k${i}`).join("/");
    expect(() => setAt({}, deep, 1)).toThrow(/levels deep/);
  });

  it("turns a rejected patch into a warning rather than a crash", () => {
    const { seen, onEvent } = events();
    const store = new SurfaceStore({ catalog, onEvent });
    expect(() => store.apply([{ op: "data", path: "/r/9999999", value: 1 }])).not.toThrow();
    expect(seen.some((e) => e.type === "warn")).toBe(true);
  });
});

describe("stream resilience", () => {
  /**
   * The store has a lenient mode where one bad component degrades a card rather
   * than blanking the screen. The line parser threw before the store ever saw
   * the input, so a single malformed line killed the whole surface and lenient
   * mode was decorative.
   */
  it("survives a malformed line in lenient mode", () => {
    const { seen, onEvent } = events();
    const stream = new BobStream({ catalog, format: "lines", mode: "lenient", onEvent });
    expect(() => {
      stream.push('c a Text value="ok"\n');
      stream.push("this is not a valid line\n");
      stream.push("r a\n");
      stream.close();
    }).not.toThrow();
    expect(stream.store.snapshot.root).toBe("a");
    expect(seen.some((e) => e.type === "warn")).toBe(true);
    expect(seen.some((e) => e.type === "done")).toBe(true);
  });

  it("fails the surface on a malformed line in strict mode", () => {
    const { seen, onEvent } = events();
    const stream = new BobStream({ catalog, format: "lines", mode: "strict", onEvent });
    stream.push("garbage line\n");
    expect(seen.some((e) => e.type === "error")).toBe(true);
  });

  it("keeps a trailing jsonl line that has no newline", () => {
    // close() flushed the line buffer for `lines` only, so the final op of a
    // jsonl response, usually `root`, was silently dropped.
    const stream = new BobStream({ catalog, format: "jsonl" });
    stream.push(
      '{"op":"component","node":{"id":"a","type":"Text","props":{"value":"hi"},"children":[]}}\n',
    );
    stream.push('{"op":"root","id":"a"}');
    stream.close();
    expect(stream.store.snapshot.root).toBe("a");
  });

  it("reports a jsonl line that is not JSON instead of swallowing it", () => {
    const { seen, onEvent } = events();
    const stream = new BobStream({ catalog, format: "jsonl", onEvent });
    stream.push("Here is your interface:\n");
    stream.close();
    expect(seen.some((e) => e.type === "warn" || e.type === "error")).toBe(true);
  });
});
