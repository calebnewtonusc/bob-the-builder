import { describe, expect, it } from "vitest";
import { parsePartialJson, PartialJsonStream } from "../src/core/partial.js";

describe("parsePartialJson", () => {
  it("passes complete documents through untouched", () => {
    const r = parsePartialJson('{"a":1,"b":[2,3]}');
    expect(r.value).toEqual({ a: 1, b: [2, 3] });
    expect(r.complete).toBe(true);
    expect(r.repaired).toBe(false);
  });

  it("closes an open object", () => {
    const r = parsePartialJson('{"a":1,');
    expect(r.value).toEqual({ a: 1 });
    expect(r.repaired).toBe(true);
  });

  it("closes nested containers from the inside out", () => {
    // The trailing 2 has no delimiter after it, so it might still become 25.
    // It is dropped; the 1 is kept because the comma proved it ended.
    const r = parsePartialJson('{"a":{"b":[1,2');
    expect(r.value).toEqual({ a: { b: [1] } });
  });

  it("drops an unterminated string along with its key", () => {
    const r = parsePartialJson('{"a":1,"b":"hel');
    expect(r.value).toEqual({ a: 1 });
    expect(r.value).not.toHaveProperty("b");
  });

  it("drops a key whose value has not started", () => {
    const r = parsePartialJson('{"a":1,"b":');
    expect(r.value).toEqual({ a: 1 });
  });

  it("drops a trailing number, because 12 might become 1200", () => {
    const r = parsePartialJson('{"total":12');
    expect(r.value).toEqual({});
  });

  it("keeps a number once a delimiter proves it ended", () => {
    expect(parsePartialJson('{"total":12,').value).toEqual({ total: 12 });
    expect(parsePartialJson('{"total":12}').value).toEqual({ total: 12 });
  });

  it("drops a partial literal", () => {
    expect(parsePartialJson('{"ok":tru').value).toEqual({});
    expect(parsePartialJson('{"ok":true}').value).toEqual({ ok: true });
  });

  it("handles arrays of partial objects", () => {
    // The third object has only a dangling key, so it is discarded rather than
    // closed as {}. Closing it would add a row that is not in the data.
    const r = parsePartialJson('[{"id":1},{"id":2},{"id"');
    expect(r.value).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("never closes an empty container into a phantom value", () => {
    expect(parsePartialJson('[{"a":1},{').value).toEqual([{ a: 1 }]);
    expect(parsePartialJson('[1,2,[').value).toEqual([1, 2]);
  });

  it("keeps a string value that lands last, and drops a key that does", () => {
    expect(parsePartialJson('{"a":"hi"').value).toEqual({ a: "hi" });
    expect(parsePartialJson('{"a":1,"b"').value).toEqual({ a: 1 });
  });

  it("is not fooled by braces or quotes inside strings", () => {
    const r = parsePartialJson('{"code":"if (x) { y }","n":1');
    expect(r.value).toEqual({ code: "if (x) { y }" });
    expect(parsePartialJson('{"code":"if (x) { y }","n":1}').value).toEqual({
      code: "if (x) { y }",
      n: 1,
    });
  });

  it("handles escaped quotes", () => {
    const r = parsePartialJson('{"q":"she said \\"hi\\"","n":2');
    expect(r.value).toEqual({ q: 'she said "hi"' });
  });

  it("returns undefined when nothing complete has arrived", () => {
    expect(parsePartialJson("").value).toBeUndefined();
    expect(parsePartialJson('"unterminated').value).toBeUndefined();
  });

  it("never yields a scalar that differs from its final value", () => {
    // The guarantee under test: at any point in the stream, a scalar that is
    // visible is already correct. Containers are allowed to be incomplete, since
    // a half-filled array is honestly half-filled; a half-parsed number is a
    // different number, and that is the failure this parser exists to prevent.
    const full = '{"title":"Q3 report","total":48200,"open":true,"rows":[{"r":"West","v":1840}]}';
    const target = JSON.parse(full) as Record<string, unknown>;

    for (let i = 0; i <= full.length; i++) {
      const { value } = parsePartialJson<Record<string, unknown>>(full.slice(0, i));
      if (value === undefined) continue;
      for (const [k, v] of Object.entries(value)) {
        if (v !== null && typeof v === "object") continue;
        expect(v).toBe(target[k]);
      }
    }
  });

  it("never yields a scalar mid-token at any prefix of a numeric stream", () => {
    const full = '{"a":1234567,"b":98765}';
    for (let i = 0; i <= full.length; i++) {
      const { value } = parsePartialJson<{ a?: number; b?: number }>(full.slice(0, i));
      if (value?.a !== undefined) expect(value.a).toBe(1234567);
      if (value?.b !== undefined) expect(value.b).toBe(98765);
    }
  });
});

describe("PartialJsonStream", () => {
  it("accumulates across chunks", () => {
    const s = new PartialJsonStream<{ a?: number; b?: string }>();
    expect(s.push('{"a":').value).toEqual({});
    expect(s.push("1,").value).toEqual({ a: 1 });
    expect(s.push('"b":"hi"}').value).toEqual({ a: 1, b: "hi" });
    expect(s.current.complete).toBe(true);
  });

  it("resets cleanly", () => {
    const s = new PartialJsonStream();
    s.push('{"a":1}');
    s.reset();
    expect(s.current.value).toBeUndefined();
    expect(s.raw).toBe("");
  });
});
