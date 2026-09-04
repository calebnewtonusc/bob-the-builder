import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineCatalog, defineComponent } from "../src/core/catalog.js";
import { SurfaceStore } from "../src/core/store.js";
import { WeftStream } from "../src/core/stream.js";
import type { SurfaceEvent } from "../src/core/spec.js";

const catalog = defineCatalog({
  name: "test",
  components: {
    Stack: defineComponent({
      props: z.object({ gap: z.number().optional() }),
      describe: "Layout container for a group of children.",
      a11y: { role: "group", name: { from: "none" } },
      skeleton: { shape: "none" },
    }),
    Text: defineComponent({
      props: z.object({ value: z.string() }),
      describe: "A paragraph of prose content.",
      a11y: { name: { from: "children" } },
      skeleton: { shape: "text", lines: 2 },
      children: [],
    }),
    Button: defineComponent({
      props: z.object({ label: z.string().min(1), action: z.string() }),
      describe: "Fires a named action back at the agent.",
      a11y: { role: "button", name: { from: "prop", prop: "label" }, keyboard: true },
      skeleton: { shape: "block" },
      children: [],
    }),
  },
  actions: { go: { describe: "Do the thing." } },
});

function collect(): { events: SurfaceEvent[]; onEvent: (e: SurfaceEvent) => void } {
  const events: SurfaceEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

describe("root gate", () => {
  it("does not fire ready before the root arrives", () => {
    const { events, onEvent } = collect();
    const store = new SurfaceStore({ catalog, onEvent });

    store.apply([
      { op: "component", node: { id: "a", type: "Text", props: { value: "hi" }, children: [] } },
    ]);
    expect(events.filter((e) => e.type === "ready")).toHaveLength(0);
    expect(store.isReady).toBe(false);

    store.apply([{ op: "root", id: "a" }]);
    expect(events.filter((e) => e.type === "ready")).toHaveLength(1);
    expect(store.isReady).toBe(true);
  });

  it("does not fire ready when the root is declared but never arrives", () => {
    const { events, onEvent } = collect();
    const store = new SurfaceStore({ catalog, onEvent });
    store.apply([{ op: "root", id: "ghost" }]);
    expect(store.isReady).toBe(false);
    store.finish();
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("fires ready exactly once", () => {
    const { events, onEvent } = collect();
    const store = new SurfaceStore({ catalog, onEvent });
    store.apply([
      { op: "component", node: { id: "a", type: "Text", props: { value: "x" }, children: [] } },
      { op: "root", id: "a" },
    ]);
    store.apply([
      { op: "component", node: { id: "a", type: "Text", props: { value: "y" }, children: [] } },
    ]);
    expect(events.filter((e) => e.type === "ready")).toHaveLength(1);
    expect(events.filter((e) => e.type === "patch").length).toBeGreaterThan(0);
  });
});

describe("out-of-order arrival", () => {
  it("accepts children before the parent exists", () => {
    const store = new SurfaceStore({ catalog });
    store.apply([
      { op: "children", id: "page", children: ["a", "b"] },
      { op: "component", node: { id: "page", type: "Stack", props: {}, children: [] } },
      { op: "component", node: { id: "a", type: "Text", props: { value: "one" }, children: [] } },
      { op: "component", node: { id: "b", type: "Text", props: { value: "two" }, children: [] } },
      { op: "root", id: "page" },
    ]);
    expect(store.snapshot.elements["page"]!.children).toEqual(["a", "b"]);
    expect(store.resolve().order).toEqual(["page", "a", "b"]);
  });

  it("tracks a dangling child and clears it on arrival", () => {
    const { events, onEvent } = collect();
    const store = new SurfaceStore({ catalog, onEvent });

    store.apply([
      { op: "component", node: { id: "page", type: "Stack", props: {}, children: [] } },
      { op: "children", id: "page", children: ["late"] },
      { op: "root", id: "page" },
    ]);
    expect(store.pendingIds).toEqual(["late"]);

    store.apply([
      { op: "component", node: { id: "late", type: "Text", props: { value: "here" }, children: [] } },
    ]);
    expect(store.pendingIds).toEqual([]);
    expect(events.some((e) => e.type === "pending")).toBe(true);
  });
});

describe("validation", () => {
  it("drops an unknown component in lenient mode and keeps the rest", () => {
    const { events, onEvent } = collect();
    const store = new SurfaceStore({ catalog, onEvent });
    store.apply([
      { op: "component", node: { id: "page", type: "Stack", props: {}, children: [] } },
      { op: "component", node: { id: "x", type: "Carousel", props: {}, children: [] } },
      { op: "root", id: "page" },
    ]);
    expect(store.snapshot.elements["x"]).toBeUndefined();
    expect(store.isReady).toBe(true);
    expect(events.some((e) => e.type === "warn")).toBe(true);
  });

  it("fails the surface on an unknown component in strict mode", () => {
    const { events, onEvent } = collect();
    const store = new SurfaceStore({ catalog, mode: "strict", onEvent });
    store.apply([
      { op: "component", node: { id: "x", type: "Carousel", props: {}, children: [] } },
    ]);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("rejects props that fail the schema", () => {
    const { events, onEvent } = collect();
    const store = new SurfaceStore({ catalog, onEvent });
    store.apply([
      { op: "component", node: { id: "b", type: "Button", props: { label: "", action: "go" }, children: [] } },
    ]);
    expect(store.snapshot.elements["b"]).toBeUndefined();
    expect(events.some((e) => e.type === "warn")).toBe(true);
  });

  it("lets a binding satisfy a required prop", () => {
    const store = new SurfaceStore({ catalog });
    store.apply([
      {
        op: "component",
        node: {
          id: "t",
          type: "Text",
          props: { value: { $bind: "/msg" } },
          children: [],
        },
      },
    ]);
    expect(store.snapshot.elements["t"]).toBeDefined();
  });
});

describe("cycles", () => {
  it("cuts a cycle instead of hanging", () => {
    const store = new SurfaceStore({ catalog });
    store.apply([
      { op: "component", node: { id: "a", type: "Stack", props: {}, children: [] } },
      { op: "component", node: { id: "b", type: "Stack", props: {}, children: [] } },
      { op: "children", id: "a", children: ["b"] },
      { op: "children", id: "b", children: ["a"] },
      { op: "root", id: "a" },
    ]);
    const { order, cycles } = store.resolve();
    expect(cycles).toContain("a");
    expect(order).toEqual(["a", "b"]);
  });
});

describe("data model", () => {
  it("patches a leaf without touching the graph", () => {
    const store = new SurfaceStore({ catalog });
    store.apply([
      { op: "data", path: "/user/name", value: "Ada" },
      { op: "data", path: "/user/age", value: 36 },
    ]);
    expect(store.snapshot.data).toEqual({ user: { name: "Ada", age: 36 } });

    store.apply([{ op: "data", path: "/user/age", value: undefined }]);
    expect(store.snapshot.data).toEqual({ user: { name: "Ada" } });
  });

  it("builds arrays when the next segment is an index", () => {
    const store = new SurfaceStore({ catalog });
    store.apply([{ op: "data", path: "/rows/0/total", value: 12 }]);
    expect(store.snapshot.data).toEqual({ rows: [{ total: 12 }] });
  });
});

describe("WeftStream", () => {
  it("assembles a surface from Weft Lines chunks", async () => {
    const onEvent = vi.fn();
    const stream = new WeftStream({ catalog, format: "lines", onEvent });

    const source = [
      "c page Stack gap=4\n",
      "> page title body\n",
      'c title Text value="Hello"\n',
      'c body Text value="World"\n',
      "r page\n",
    ];
    for (const chunk of source) stream.push(chunk);
    stream.close();

    const spec = stream.store.snapshot;
    expect(spec.root).toBe("page");
    expect(Object.keys(spec.elements).sort()).toEqual(["body", "page", "title"]);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "done" }));
  });

  it("assembles the same surface from a single streamed JSON object", () => {
    const stream = new WeftStream({ catalog, format: "json" });
    const doc = JSON.stringify({
      root: "page",
      elements: {
        page: { type: "Stack", props: { gap: 4 }, children: ["title"] },
        title: { type: "Text", props: { value: "Hello" }, children: [] },
      },
      data: {},
    });
    for (const ch of doc) stream.push(ch);
    stream.close();

    expect(stream.store.snapshot.root).toBe("page");
    expect(stream.store.snapshot.elements["title"]!.props["value"]).toBe("Hello");
  });

  it("consumes an async iterable", async () => {
    const stream = new WeftStream({ catalog, format: "lines" });
    async function* gen() {
      yield 'c a Text value="hi"\n';
      yield "r a\n";
    }
    const spec = await stream.consume(gen());
    expect(spec.root).toBe("a");
  });
});

describe("time to first paint", () => {
  /** Feed a response one character at a time and record when ready fires. */
  function stream(response: string): { readyAt: number; paints: number; total: number } {
    let readyAt = -1;
    let paints = 0;
    const s = new WeftStream({
      catalog,
      format: "lines",
      onEvent: (e) => {
        if (e.type === "ready") {
          readyAt = consumed;
          paints++;
        }
        if (e.type === "patch") paints++;
      },
    });
    let consumed = 0;
    for (const ch of response) {
      consumed++;
      s.push(ch);
    }
    s.close();
    return { readyAt, paints, total: response.length };
  }

  const body = [
    "> page a b",
    'c a Text value="first"',
    'c b Text value="second"',
  ].join("\n");

  it("paints early when the root is claimed second", () => {
    // The order the generated prompt asks for.
    const { readyAt, paints, total } = stream(
      `c page Stack gap=4\nr page\n${body}\n`,
    );
    expect(readyAt).toBeGreaterThan(0);
    // Ready well before the response finishes, and the surface keeps updating.
    expect(readyAt).toBeLessThan(total * 0.4);
    expect(paints).toBeGreaterThan(1);
  });

  it("paints only at the end when the root is claimed last", () => {
    // The order a model reaches for unprompted, and the reason the prompt says
    // otherwise. Nothing can render until `r` arrives.
    const { readyAt, paints, total } = stream(
      `c page Stack gap=4\n${body}\nr page\n`,
    );
    expect(readyAt).toBeGreaterThan(total * 0.9);
    expect(paints).toBe(1);
  });
});
