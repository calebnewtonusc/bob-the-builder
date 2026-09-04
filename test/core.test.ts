/**
 * Coverage for the three modules that shipped with no tests at all: the JSON
 * Pointer implementation the whole data model rests on, catalog construction,
 * and the generated system prompt.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  formatPointer,
  getAt,
  parsePointer,
  setAt,
} from "../src/core/pointer.js";
import {
  defineCatalog,
  defineComponent,
  isValidId,
} from "../src/core/catalog.js";
import { buildSystemPrompt } from "../src/core/prompt.js";
import { resolveProps } from "../src/core/stream.js";
import { serializeOp } from "../src/core/lines.js";
import type { Json } from "../src/core/spec.js";
import { catalog as starter } from "../examples/catalog.js";

describe("JSON Pointer", () => {
  it("parses and formats, round trip", () => {
    expect(parsePointer("/a/b/c")).toEqual(["a", "b", "c"]);
    expect(parsePointer("")).toEqual([]);
    // "/" means root here, a documented deviation from RFC 6901.
    expect(parsePointer("/")).toEqual([]);
    expect(formatPointer(["a", "b"])).toBe("/a/b");
    expect(formatPointer([])).toBe("");
  });

  it("handles the RFC 6901 escapes", () => {
    // ~1 is "/" and ~0 is "~". Decoding in the wrong order corrupts "~01".
    expect(parsePointer("/a~1b")).toEqual(["a/b"]);
    expect(parsePointer("/m~0n")).toEqual(["m~n"]);
    expect(formatPointer(["a/b"])).toBe("/a~1b");
    expect(formatPointer(["m~n"])).toBe("/m~0n");
  });

  it("rejects a pointer that does not start with a slash", () => {
    expect(() => parsePointer("a/b")).toThrow(/must start with/);
  });

  it("reads through objects and arrays", () => {
    const root = { a: { b: [{ c: 1 }] } };
    expect(getAt(root, "/a/b/0/c")).toBe(1);
    expect(getAt(root, "/a/b/9/c")).toBeUndefined();
    expect(getAt(root, "/nope")).toBeUndefined();
    expect(getAt(root, "/a/b/0/c/deeper")).toBeUndefined();
  });

  it("creates objects and arrays by looking at the next segment", () => {
    const root: Record<string, Json> = {};
    setAt(root, "/rows/0/total", 12);
    expect(root).toEqual({ rows: [{ total: 12 }] });

    const other: Record<string, Json> = {};
    setAt(other, "/user/name", "Ada");
    expect(other).toEqual({ user: { name: "Ada" } });
  });

  it("upserts, replacing an existing value", () => {
    const root: Record<string, Json> = { a: 1 };
    setAt(root, "/a", 2);
    expect(root["a"]).toBe(2);
  });

  it("deletes on undefined, splicing arrays", () => {
    const root: Record<string, Json> = { a: 1, list: [1, 2, 3] };
    setAt(root, "/a", undefined);
    expect(root).not.toHaveProperty("a");
    setAt(root, "/list/1", undefined);
    expect(root["list"]).toEqual([1, 3]);
  });

  it("replaces the whole root, and refuses a non-object", () => {
    const root: Record<string, Json> = { old: 1 };
    setAt(root, "", { fresh: 2 });
    expect(root).toEqual({ fresh: 2 });
    expect(() => setAt(root, "", 5 as unknown as Json)).toThrow(/non-object/);
  });

  it("widens a scalar into a container rather than failing", () => {
    // Upsert semantics: a model streaming a structure top-down writes /a before
    // it writes /a/b, and failing the second would lose the whole subtree.
    const root: Record<string, Json> = { a: 1 };
    setAt(root, "/a/b/c", 2);
    expect(root).toEqual({ a: { b: { c: 2 } } });
  });
});

describe("catalog construction", () => {
  const ok = defineComponent({
    props: z.object({ value: z.string() }),
    describe: "A paragraph of prose content.",
    a11y: { name: { from: "children" } },
    skeleton: { shape: "text", lines: 1 },
  });

  it("rejects a non-PascalCase component name", () => {
    expect(() =>
      defineCatalog({ name: "x", components: { metric: ok } }),
    ).toThrow(/PascalCase/);
  });

  it("rejects an allowed child that is not in the catalog", () => {
    expect(() =>
      defineCatalog({
        name: "x",
        components: { Stack: { ...ok, children: ["Ghost"] } },
      }),
    ).toThrow(/not in the catalog/);
  });

  it("exposes sorted names and lookups", () => {
    expect(starter.componentNames).toEqual([...starter.componentNames].sort());
    expect(starter.has("Metric")).toBe(true);
    expect(starter.has("Carousel")).toBe(false);
    expect(starter.hasAction("send_report")).toBe(true);
    expect(starter.get("Metric")?.describe).toContain("number");
  });

  it("reads prop keys off each schema for allow-listing", () => {
    const keys = starter.propKeys("Metric");
    expect(keys).not.toBeNull();
    expect([...keys!].sort()).toEqual(["delta", "label", "unit", "value"]);
  });

  it("enforces composition rules only where declared", () => {
    // Heading declares children: [] so it allows nothing; Stack omits the field
    // and therefore allows anything.
    expect(starter.allowsChild("Heading", "Text")).toBe(false);
    expect(starter.allowsChild("Stack", "Text")).toBe(true);
    expect(starter.allowsChild("Nope", "Text")).toBe(false);
  });

  it("validates ids and reserves the double-underscore namespace", () => {
    expect(isValidId("hero-1")).toBe(true);
    expect(isValidId("a_b")).toBe(true);
    expect(isValidId("__pending__")).toBe(false);
    expect(isValidId("has space")).toBe(false);
    expect(isValidId("")).toBe(false);
    expect(isValidId("x".repeat(65))).toBe(false);
  });
});

describe("generated system prompt", () => {
  it("names every component and action", () => {
    const prompt = buildSystemPrompt(starter);
    for (const name of starter.componentNames) {
      expect(prompt).toContain(`### ${name}`);
    }
    for (const action of starter.actionNames) {
      expect(prompt).toContain(action);
    }
  });

  it("teaches the fast ordering, which is worth 20x on first paint", () => {
    const prompt = buildSystemPrompt(starter, { format: "lines" });
    expect(prompt).toMatch(/root component/i);
    expect(prompt).toMatch(/appears immediately|second/i);
  });

  it("changes its format rules per wire format", () => {
    expect(buildSystemPrompt(starter, { format: "lines" })).toContain("Bob Lines");
    expect(buildSystemPrompt(starter, { format: "jsonl" })).toContain('"op"');
    expect(buildSystemPrompt(starter, { format: "json" })).toContain('"elements"');
  });

  it("carries prop signatures read off the Zod schemas", () => {
    const prompt = buildSystemPrompt(starter);
    expect(prompt).toContain("label=string");
    expect(prompt).toContain("delta=number?");
  });

  it("includes examples by default and drops them on request", () => {
    const withEx = buildSystemPrompt(starter, { examples: true });
    const without = buildSystemPrompt(starter, { examples: false });
    expect(withEx.length).toBeGreaterThan(without.length);
    expect(without).not.toContain("c rev Metric");
  });

  it("appends the task and the catalog guidance", () => {
    const prompt = buildSystemPrompt(starter, { task: "Summarise Q3." });
    expect(prompt).toContain("Summarise Q3.");
    expect(prompt).toContain("Catalog guidance");
  });

  it("forbids placeholder content, which bob check also enforces", () => {
    expect(buildSystemPrompt(starter)).toMatch(/Lorem ipsum/);
  });
});

describe("resolveProps", () => {
  it("resolves bindings and passes literals through", () => {
    const out = resolveProps(
      { label: "Revenue", value: { $bind: "/totals/revenue" } },
      { totals: { revenue: 4820000 } },
    );
    expect(out).toEqual({ label: "Revenue", value: 4820000 });
  });

  it("omits a binding that does not resolve, rather than passing undefined", () => {
    const out = resolveProps({ value: { $bind: "/missing" } }, {});
    expect(out).not.toHaveProperty("value");
  });
});

describe("serializeOp", () => {
  it("round trips every op kind", () => {
    expect(serializeOp({ op: "root", id: "page" })).toBe("r page");
    expect(serializeOp({ op: "children", id: "p", children: ["a", "b"] })).toBe("> p a b");
    expect(serializeOp({ op: "data", path: "/a", value: 1 })).toBe("d /a 1");
    expect(serializeOp({ op: "data", path: "/a", value: undefined })).toBe("d /a");
    expect(
      serializeOp({
        op: "component",
        node: { id: "t", type: "Text", props: { value: "hi there" }, children: [] },
      }),
    ).toBe('c t Text value="hi there"');
  });

  it("keeps bare words bare, because quotes cost tokens", () => {
    expect(
      serializeOp({
        op: "component",
        node: { id: "b", type: "Button", props: { variant: "primary" }, children: [] },
      }),
    ).toBe("c b Button variant=primary");
  });
});
