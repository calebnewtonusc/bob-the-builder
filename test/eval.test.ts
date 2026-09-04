/**
 * The eval harness, and especially the stability metric, which is the claim the
 * whole repo now rests on. A metric nobody else publishes had better be tested
 * against cases where the right answer is obvious.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineComponent } from "../src/core/catalog.js";
import { parseLines } from "../src/core/lines.js";
import { SurfaceStore } from "../src/core/store.js";
import type { Spec } from "../src/core/spec.js";
import {
  componentCounts,
  measureStability,
  multisetJaccard,
  shapeSignature,
  treeDepth,
} from "../src/eval/metrics.js";
import {
  avoidsComponent,
  defineScenarios,
  firstPaintUnder,
  maxDepth,
  maxTokens,
  noPlaceholders,
  renders,
  usesComponent,
} from "../src/eval/scenario.js";
import { replayAdapter } from "../src/eval/adapter.js";
import {
  compareToBaseline,
  runEval,
  toBaseline,
} from "../src/eval/runner.js";
import { catalog as starter } from "../examples/catalog.js";

function specOf(source: string): Spec {
  const store = new SurfaceStore({ catalog: starter });
  store.apply(parseLines(source));
  return store.snapshot;
}

const TABLE = `c page Stack
r page
> page t
c t Table caption="Revenue by region" columns=["R","V"] rows=[["West",1]]
`;

const TABLE_WITH_SUMMARY = `c page Stack
r page
> page s t
c s Text value="West led on revenue."
c t Table caption="Revenue by region" columns=["R","V"] rows=[["West",1]]
`;

const PROSE = `c page Stack
r page
> page s
c s Text value="West led on revenue this quarter."
`;

describe("shape and size", () => {
  it("signs a tree by type, ignoring ids and content", () => {
    expect(shapeSignature(specOf(TABLE))).toBe("Stack(Table)");
    expect(shapeSignature(specOf(TABLE_WITH_SUMMARY))).toBe("Stack(Text,Table)");
  });

  it("gives two runs with different content the same signature", () => {
    const a = specOf(TABLE);
    const b = specOf(
      TABLE.replace("Revenue by region", "Q3 revenue").replace("West", "East"),
    );
    expect(shapeSignature(a)).toBe(shapeSignature(b));
  });

  it("counts components as a multiset", () => {
    const counts = componentCounts(specOf(TABLE_WITH_SUMMARY));
    expect(counts.get("Table")).toBe(1);
    expect(counts.get("Text")).toBe(1);
    expect(counts.get("Stack")).toBe(1);
  });

  it("measures depth", () => {
    expect(treeDepth(specOf(TABLE))).toBe(2);
    expect(treeDepth(specOf(`c a Stack\nr a\n`))).toBe(1);
  });
});

describe("multiset Jaccard", () => {
  it("is 1 for identical multisets and 0 for disjoint ones", () => {
    const a = new Map([["Table", 1]]);
    expect(multisetJaccard(a, new Map([["Table", 1]]))).toBe(1);
    expect(multisetJaccard(a, new Map([["Text", 1]]))).toBe(0);
  });

  it("distinguishes quantity, not just presence", () => {
    // One Metric and four Metrics are different interfaces. A plain set says
    // they are identical, which is why this is a multiset.
    const one = new Map([["Metric", 1]]);
    const four = new Map([["Metric", 4]]);
    expect(multisetJaccard(one, four)).toBe(0.25);
  });

  it("treats two empty multisets as identical", () => {
    expect(multisetJaccard(new Map(), new Map())).toBe(1);
  });
});

describe("stability", () => {
  it("is 1.0 when every run produced the same interface", () => {
    const report = measureStability([specOf(TABLE), specOf(TABLE), specOf(TABLE)]);
    expect(report.stability).toBe(1);
    expect(report.components).toBe(1);
    expect(report.shape).toBe(1);
    expect(report.variants).toHaveLength(1);
  });

  it("is 1.0 when content differs but the layout does not", () => {
    // The distinction that matters: users relearn a layout, not a value.
    const other = TABLE.replace("Revenue by region", "Q3 revenue");
    const report = measureStability([specOf(TABLE), specOf(other)]);
    expect(report.stability).toBe(1);
  });

  it("falls when a run answers with a different component entirely", () => {
    const report = measureStability([specOf(TABLE), specOf(PROSE)]);
    expect(report.stability).toBeLessThan(0.5);
    expect(report.components).toBeLessThan(0.5);
    expect(report.shape).toBe(0);
  });

  it("falls a little when one run adds a component", () => {
    const report = measureStability([
      specOf(TABLE),
      specOf(TABLE),
      specOf(TABLE_WITH_SUMMARY),
    ]);
    expect(report.stability).toBeGreaterThan(0.5);
    expect(report.stability).toBeLessThan(0.9);
    // And it names the disagreement rather than only scoring it.
    expect(report.variants).toHaveLength(2);
    expect(report.variants[0]!.runs).toBe(2);
    expect(report.variants[0]!.signature).toBe("Stack(Table)");
  });

  it("orders variants by how often they occurred", () => {
    const report = measureStability([
      specOf(PROSE),
      specOf(TABLE),
      specOf(TABLE),
      specOf(TABLE),
    ]);
    expect(report.variants[0]!.signature).toBe("Stack(Table)");
    expect(report.variants[0]!.runs).toBe(3);
  });

  it("is 1.0 for a single run, because one run cannot disagree", () => {
    expect(measureStability([specOf(TABLE)]).stability).toBe(1);
  });

  it("handles an empty set without dividing by zero", () => {
    const report = measureStability([]);
    expect(report.stability).toBe(0);
    expect(report.runs).toBe(0);
  });
});

describe("assertions", () => {
  const catalog = starter;
  const run = (source: string) => ({
    spec: specOf(source),
    raw: source,
    warnings: [],
    error: null,
    tokens: 100,
    firstPaintAt: 0.1,
  });

  it("usesComponent counts occurrences", () => {
    expect(usesComponent("Table").check(run(TABLE), catalog).pass).toBe(true);
    expect(usesComponent("Table", 2).check(run(TABLE), catalog).pass).toBe(false);
    expect(usesComponent("Metric").check(run(TABLE), catalog).pass).toBe(false);
  });

  it("avoidsComponent catches a comparison answered in prose", () => {
    expect(avoidsComponent("Text").check(run(TABLE), catalog).pass).toBe(true);
    expect(avoidsComponent("Text").check(run(PROSE), catalog).pass).toBe(false);
  });

  it("maxDepth and maxTokens hold their limits", () => {
    expect(maxDepth(2).check(run(TABLE), catalog).pass).toBe(true);
    expect(maxDepth(1).check(run(TABLE), catalog).pass).toBe(false);
    expect(maxTokens(100).check(run(TABLE), catalog).pass).toBe(true);
    expect(maxTokens(99).check(run(TABLE), catalog).pass).toBe(false);
  });

  it("firstPaintUnder guards the prompt ordering worth 23x", () => {
    expect(firstPaintUnder(0.35).check(run(TABLE), catalog).pass).toBe(true);
    const late = { ...run(TABLE), firstPaintAt: 0.95 };
    expect(firstPaintUnder(0.35).check(late, catalog).pass).toBe(false);
    const never = { ...run(TABLE), firstPaintAt: -1 };
    expect(firstPaintUnder(0.35).check(never, catalog).detail).toMatch(/never/);
  });

  it("noPlaceholders catches filler a user cannot distinguish from an answer", () => {
    const filler = `c page Text value="Lorem ipsum dolor sit amet"\nr page\n`;
    expect(noPlaceholders().check(run(filler), catalog).pass).toBe(false);
    expect(noPlaceholders().check(run(TABLE), catalog).pass).toBe(true);
  });

  it("renders fails when nothing assembled", () => {
    const empty = { ...run(TABLE), spec: specOf("c a Text value=x\n") };
    expect(renders().check(empty, catalog).pass).toBe(false);
  });
});

describe("runner", () => {
  const catalog = defineCatalog({
    name: "eval-test",
    components: {
      Stack: defineComponent({
        props: z.object({ gap: z.number().optional() }),
        describe: "Layout container holding a group of children.",
        a11y: { role: "group", name: { from: "none" } },
        skeleton: { shape: "none" },
      }),
      Text: defineComponent({
        props: z.object({ value: z.string() }),
        describe: "A paragraph of prose content.",
        a11y: { name: { from: "children" }, live: "polite" },
        skeleton: { shape: "text", lines: 1 },
        children: [],
      }),
    },
  });

  const stable = `c p Stack\nr p\n> p t\nc t Text value="steady"\n`;
  const different = `c p Stack\nr p\n> p t u\nc t Text value="a"\nc u Text value="b"\n`;

  it("runs every scenario the requested number of times", async () => {
    const suite = defineScenarios({
      catalog,
      runs: 3,
      scenarios: [
        { name: "s", prompt: "go", expect: [renders(), usesComponent("Text")] },
      ],
    });
    const report = await runEval(suite, {
      adapter: replayAdapter({ go: [stable] }),
    });
    expect(report.scenarios[0]!.runs).toHaveLength(3);
    expect(report.scenarios[0]!.stability.stability).toBe(1);
    expect(report.pass).toBe(true);
  });

  it("fails a scenario on stability alone, with every assertion passing", async () => {
    // The reason this harness exists. The interface is correct every time and
    // still moves around, which is the failure users actually complain about
    // and which no assertion-only tool can express.
    const suite = defineScenarios({
      catalog,
      runs: 4,
      minStability: 0.9,
      scenarios: [{ name: "wobbly", prompt: "go", expect: [renders()] }],
    });
    const report = await runEval(suite, {
      adapter: replayAdapter({ go: [stable, different] }),
    });
    const s = report.scenarios[0]!;
    expect(s.assertions.every((a) => a.passed === a.total)).toBe(true);
    expect(s.pass).toBe(false);
    expect(s.reasons.join(" ")).toMatch(/stability/);
  });

  it("measures where in the stream the first paint became possible", async () => {
    const suite = defineScenarios({
      catalog,
      runs: 1,
      scenarios: [{ name: "s", prompt: "go", expect: [] }],
    });

    const early = await runEval(suite, {
      adapter: replayAdapter({ go: [stable] }, { chunkSize: 4 }),
    });
    // Root is claimed on line two, so the paint lands early in the stream.
    expect(early.scenarios[0]!.meanFirstPaint).toBeLessThan(0.4);

    const lateSource = `c p Stack\n> p t\nc t Text value="steady"\nr p\n`;
    const late = await runEval(suite, {
      adapter: replayAdapter({ go: [lateSource] }, { chunkSize: 4 }),
    });
    expect(late.scenarios[0]!.meanFirstPaint).toBeGreaterThan(0.8);
  });

  it("reports a scenario that never assembled instead of throwing", async () => {
    const suite = defineScenarios({
      catalog,
      runs: 1,
      scenarios: [{ name: "s", prompt: "go", expect: [renders()] }],
    });
    const report = await runEval(suite, {
      adapter: replayAdapter({ go: ["c t Text value=x\n"] }),
    });
    expect(report.pass).toBe(false);
    expect(report.scenarios[0]!.assertions[0]!.passed).toBe(0);
  });
});

describe("baselines", () => {
  const base = {
    model: "recorded",
    recordedAt: "2026-01-01T00:00:00.000Z",
    scenarios: {
      s: { stability: 0.95, meanTokens: 100, meanFirstPaint: 0.15, passed: 2 },
    },
  };

  const reportWith = (
    stability: number,
    meanTokens: number,
    meanFirstPaint: number,
    passed: number,
  ) => ({
    model: "recorded",
    format: "lines",
    startedAt: "",
    durationMs: 0,
    pass: true,
    scenarios: [
      {
        name: "s",
        runs: [],
        stability: {
          stability,
          components: 1,
          shape: 1,
          depth: 1,
          variants: [],
          runs: 3,
        },
        assertions: Array.from({ length: passed }, (_, i) => ({
          name: `a${i}`,
          passed: 1,
          total: 1,
          failures: [],
        })),
        minStability: 0.8,
        meanTokens,
        meanFirstPaint,
        pass: true,
        reasons: [],
      },
    ],
  });

  it("passes when nothing moved", () => {
    expect(compareToBaseline(reportWith(0.95, 100, 0.15, 2), base)).toEqual([]);
  });

  it("catches an interface that got less stable", () => {
    const regs = compareToBaseline(reportWith(0.7, 100, 0.15, 2), base);
    expect(regs.map((r) => r.metric)).toContain("stability");
  });

  it("catches responses that got more expensive", () => {
    const regs = compareToBaseline(reportWith(0.95, 200, 0.15, 2), base);
    expect(regs.map((r) => r.metric)).toContain("tokens");
  });

  it("catches a slower first paint, which is the prompt-ordering regression", () => {
    const regs = compareToBaseline(reportWith(0.95, 100, 0.9, 2), base);
    expect(regs.map((r) => r.metric)).toContain("firstPaint");
  });

  it("catches assertions that stopped holding", () => {
    const regs = compareToBaseline(reportWith(0.95, 100, 0.15, 1), base);
    expect(regs.map((r) => r.metric)).toContain("assertions");
  });

  it("tolerates small movement, because models are not deterministic", () => {
    expect(compareToBaseline(reportWith(0.93, 110, 0.2, 2), base)).toEqual([]);
  });

  it("ignores a scenario the baseline has never seen", () => {
    expect(compareToBaseline(reportWith(0.1, 9999, 0.99, 0), { ...base, scenarios: {} })).toEqual([]);
  });

  it("round trips through toBaseline", () => {
    const b = toBaseline(reportWith(0.95, 100, 0.15, 2));
    expect(b.scenarios["s"]!.stability).toBe(0.95);
    expect(b.scenarios["s"]!.passed).toBe(2);
  });
});

describe("replay adapter", () => {
  it("cycles recordings across runs", async () => {
    const adapter = replayAdapter({ p: ["one", "two"] });
    const read = async () => {
      let out = "";
      for await (const chunk of adapter.stream("", "p")) out += chunk;
      return out;
    };
    expect(await read()).toBe("one");
    expect(await read()).toBe("two");
    expect(await read()).toBe("one");
  });

  it("says which scenarios it has when one is missing", async () => {
    const adapter = replayAdapter({ known: ["x"] });
    await expect(async () => {
      for await (const _ of adapter.stream("", "unknown")) void _;
    }).rejects.toThrow(/known/);
  });
});

describe("a scenario can set its own stability floor", () => {
  // Not every question has the same amount of legitimate freedom in its answer,
  // and one suite-wide number is either too low to catch an ambiguous catalog
  // or too high for a genuinely open-ended request to ever pass.
  it("uses the scenario's floor when it has one", () => {
    // Its own catalog: the one above is scoped to another describe block, and
    // this test cares about the floor rather than about any component.
    const tiny = defineCatalog({
      name: "tiny",
      components: {
        Text: defineComponent({
          props: z.object({ value: z.string() }),
          describe: "A sentence, for a suite that needs one component to exist.",
          a11y: { name: { from: "children" } },
          skeleton: { shape: "text", lines: 1 },
        }),
      },
    });
    const suite = defineScenarios({
      catalog: tiny,
      minStability: 0.9,
      scenarios: [
        { name: "strict", prompt: "x", expect: [] },
        { name: "loose", prompt: "x", expect: [], minStability: 0.4 },
      ],
    });
    expect(suite.scenarios[0]!.minStability).toBeUndefined();
    expect(suite.scenarios[1]!.minStability).toBe(0.4);
    // The suite's number is still what an unmarked scenario falls back to.
    expect(suite.minStability).toBe(0.9);
  });
});
