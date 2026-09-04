import { describe, expect, it } from "vitest";
import {
  LineBuffer,
  LineParseError,
  parseLine,
  parseLines,
  serializeLines,
} from "../src/core/lines.js";

describe("parseLine", () => {
  it("parses a component with mixed prop types", () => {
    const op = parseLine('c hero Metric label="Q3 revenue" value=4820000 up=true');
    expect(op).toEqual({
      op: "component",
      node: {
        id: "hero",
        type: "Metric",
        props: { label: "Q3 revenue", value: 4820000, up: true },
        children: [],
      },
    });
  });

  it("treats a bare word as a string", () => {
    const op = parseLine("c b Button variant=primary");
    expect(op).toMatchObject({ node: { props: { variant: "primary" } } });
  });

  it("parses a data binding", () => {
    const op = parseLine("c f Field value=@/contact/email");
    expect(op).toMatchObject({ node: { props: { value: { $bind: "/contact/email" } } } });
  });

  it("parses an action reference", () => {
    const op = parseLine("c b Button action=!send_report");
    expect(op).toMatchObject({ node: { props: { action: "send_report" } } });
  });

  it("parses inline JSON with spaces inside", () => {
    const op = parseLine('c t Table columns=["Region", "Revenue"] rows=[[1, 2]]');
    expect(op).toMatchObject({
      node: { props: { columns: ["Region", "Revenue"], rows: [[1, 2]] } },
    });
  });

  it("keeps an equals sign inside a quoted value", () => {
    const op = parseLine('c t Text value="a=b"');
    expect(op).toMatchObject({ node: { props: { value: "a=b" } } });
  });

  it("parses children, data, and root", () => {
    expect(parseLine("> page a b c")).toEqual({
      op: "children",
      id: "page",
      children: ["a", "b", "c"],
    });
    expect(parseLine('d /user/name "Ada"')).toEqual({
      op: "data",
      path: "/user/name",
      value: "Ada",
    });
    expect(parseLine("d /user/name")).toEqual({
      op: "data",
      path: "/user/name",
      value: undefined,
    });
    expect(parseLine("r page")).toEqual({ op: "root", id: "page" });
  });

  it("ignores blanks and comments", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("# a note")).toBeNull();
  });

  it("rejects an unknown verb", () => {
    expect(() => parseLine("x foo")).toThrow(LineParseError);
  });

  it("rejects a component with no type", () => {
    expect(() => parseLine("c onlyid")).toThrow(LineParseError);
  });
});

describe("LineBuffer", () => {
  it("holds back a partial line until its newline arrives", () => {
    const buf = new LineBuffer();
    expect(buf.push("c a Text valu")).toEqual([]);
    expect(buf.pending).toBe("c a Text valu");
    const ops = buf.push('e="hello"\n');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ node: { props: { value: "hello" } } });
    expect(buf.pending).toBe("");
  });

  it("splits many lines from one chunk", () => {
    const buf = new LineBuffer();
    const ops = buf.push("c a Text value=hi\n> a b\nr a\n");
    expect(ops.map((o) => o.op)).toEqual(["component", "children", "root"]);
  });

  it("survives a chunk boundary mid-word", () => {
    const buf = new LineBuffer();
    const source = 'c a Metric label="Revenue" value=100\nr a\n';
    const ops = [];
    for (const ch of source) ops.push(...buf.push(ch));
    ops.push(...buf.flush());
    expect(ops).toHaveLength(2);
  });

  it("flushes a trailing line with no newline", () => {
    const buf = new LineBuffer();
    expect(buf.push("r a")).toEqual([]);
    expect(buf.flush()).toEqual([{ op: "root", id: "a" }]);
  });

  it("never emits a value that is still arriving", () => {
    const buf = new LineBuffer();
    const source = 'c total Metric label="Total" value=4820000\n';
    const seen: unknown[] = [];
    for (const ch of source) seen.push(...buf.push(ch));
    // Exactly one op, and only once the whole line landed.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ node: { props: { value: 4820000 } } });
  });
});

describe("round trip", () => {
  it("survives serialize then parse", () => {
    const source = [
      'c page Stack gap=4',
      '> page title metric',
      'c title Heading text="Q3 revenue" level=1',
      'c metric Metric label="Revenue" value=@/totals/revenue delta=12.4',
      'd /totals/revenue 4820000',
      'r page',
    ].join("\n");

    const ops = parseLines(source);
    const round = parseLines(serializeLines(ops));
    expect(round).toEqual(ops);
  });
});

describe("rejecting prose that looks like an op", () => {
  /**
   * Real model output is wrapped in English, and English sentences begin with
   * "c" and "r". These are the lines that used to parse into a valid op and
   * quietly corrupt a surface.
   */
  it("rejects a root line with anything after the id", () => {
    // This one is real: it parsed as {op:"root", id:"you"} and repointed the app.
    expect(() => parseLine("r you ready for this?")).toThrow(LineParseError);
    expect(parseLine("r page")).toEqual({ op: "root", id: "page" });
  });

  it("rejects a component whose type is not PascalCase", () => {
    expect(() => parseLine("c an app for tracking books")).toThrow(LineParseError);
    expect(() => parseLine("c a screen title=X")).toThrow(LineParseError);
    expect(parseLine("c a Screen title=X")).toMatchObject({ node: { type: "Screen" } });
  });

  it("rejects a data line whose path is not a pointer", () => {
    expect(() => parseLine("d not a pointer")).toThrow(LineParseError);
    expect(parseLine('d /a "x"')).toEqual({ op: "data", path: "/a", value: "x" });
  });
});
