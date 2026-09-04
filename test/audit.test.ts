import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineComponent } from "../src/core/catalog.js";
import { parseLines } from "../src/core/lines.js";
import { auditA11y } from "../src/audit/a11y.js";
import { auditTokens, estimateTokens } from "../src/audit/tokens.js";
import { validateOps } from "../src/audit/validate.js";
import { catalog as starter } from "../examples/catalog.js";

describe("auditA11y", () => {
  it("passes the starter catalog", () => {
    const report = auditA11y(starter);
    expect(report.errors).toBe(0);
    expect(report.pass).toBe(true);
  });

  it("catches an interactive component with no accessible name", () => {
    const bad = defineCatalog({
      name: "bad",
      components: {
        Button: defineComponent({
          props: z.object({ action: z.string() }),
          describe: "A button that nobody can identify by ear.",
          a11y: { role: "button", name: { from: "none" }, keyboard: true },
          skeleton: { shape: "block" },
        }),
      },
    });
    const report = auditA11y(bad);
    expect(report.pass).toBe(false);
    expect(report.findings.map((f) => f.rule)).toContain("interactive-needs-name");
  });

  it("catches a name prop that is not in the schema", () => {
    const bad = defineCatalog({
      name: "bad",
      components: {
        Button: defineComponent({
          props: z.object({ text: z.string() }),
          describe: "Names itself from a prop that does not exist.",
          a11y: { role: "button", name: { from: "prop", prop: "label" }, keyboard: true },
          skeleton: { shape: "block" },
        }),
      },
    });
    expect(auditA11y(bad).findings.map((f) => f.rule)).toContain("name-prop-missing");
  });

  it("catches a keyboard-inoperable interactive role", () => {
    const bad = defineCatalog({
      name: "bad",
      components: {
        Slider: defineComponent({
          props: z.object({ label: z.string() }),
          describe: "A slider you can only reach with a mouse.",
          a11y: { role: "slider", name: { from: "prop", prop: "label" }, keyboard: false },
          skeleton: { shape: "block" },
        }),
      },
    });
    expect(auditA11y(bad).findings.map((f) => f.rule)).toContain(
      "interactive-needs-keyboard",
    );
  });

  it("warns when no component can announce anything", () => {
    const quiet = defineCatalog({
      name: "quiet",
      components: {
        Text: defineComponent({
          props: z.object({ value: z.string() }),
          describe: "Static prose with no live region anywhere in the catalog.",
          a11y: { name: { from: "children" } },
          skeleton: { shape: "text", lines: 2 },
        }),
      },
    });
    expect(auditA11y(quiet).findings.map((f) => f.rule)).toContain("catalog-no-live");
  });
});

describe("validateOps", () => {
  const good = parseLines(`
c page Stack gap=4
> page title metric
c title Heading text="Q3 revenue by region" level=1
c metric Metric label="Revenue" value=4820000 unit=USD
r page
`);

  it("passes a well-formed surface", () => {
    const report = validateOps(starter, good);
    expect(report.errors).toBe(0);
    expect(report.order).toEqual(["page", "title", "metric"]);
  });

  it("catches a missing root", () => {
    const report = validateOps(starter, parseLines('c a Text value="orphan"\n'));
    expect(report.pass).toBe(false);
    expect(report.findings.map((f) => f.rule)).toContain("no-root");
  });

  it("catches a dangling child reference", () => {
    const report = validateOps(
      starter,
      parseLines("c page Stack\n> page ghost\nr page\n"),
    );
    expect(report.findings.map((f) => f.rule)).toContain("dangling-child");
  });

  it("catches lorem ipsum", () => {
    const report = validateOps(
      starter,
      parseLines('c page Text value="Lorem ipsum dolor sit amet"\nr page\n'),
    );
    expect(report.pass).toBe(false);
    expect(report.findings.map((f) => f.rule)).toContain("placeholder-content");
  });

  it("catches numbered filler", () => {
    const report = validateOps(
      starter,
      parseLines('c page Heading text="Item 1"\nr page\n'),
    );
    expect(report.findings.map((f) => f.rule)).toContain("placeholder-content");
  });

  it("catches an unreachable component", () => {
    const report = validateOps(
      starter,
      parseLines('c page Stack\nc lost Text value="Never rendered"\nr page\n'),
    );
    expect(report.findings.map((f) => f.rule)).toContain("unreachable");
  });

  it("catches a cycle", () => {
    const report = validateOps(
      starter,
      parseLines("c a Stack\nc b Stack\n> a b\n> b a\nr a\n"),
    );
    expect(report.findings.map((f) => f.rule)).toContain("cycle");
  });
});

describe("auditTokens", () => {
  const ops = parseLines(`
c page Stack gap=4
> page title email submit
c title Heading text="Request a demo" level=1
c email Field label="Work email" kind=email value=@/contact/email
c submit Button label="Send request" action=send_report variant=primary
d /contact/email ""
r page
`);

  it("finds Bob Lines cheaper than JSON on the same surface", () => {
    const report = auditTokens("contact form", ops);
    const lines = report.costs.find((c) => c.format === "lines")!;
    const json = report.costs.find((c) => c.format === "json")!;
    expect(lines.tokens).toBeLessThan(json.tokens);
    expect(report.cheapest).toBe("lines");
    expect(report.spread).toBeGreaterThan(1);
  });

  it("reports seconds at the given generation rate", () => {
    const report = auditTokens("contact form", ops, { tokensPerSecond: 60 });
    for (const cost of report.costs) {
      expect(cost.seconds).toBeCloseTo(cost.tokens / 60, 5);
    }
  });

  it("accepts a real tokenizer and says it is no longer estimating", () => {
    const report = auditTokens("contact form", ops, {
      count: (t) => t.split(/\s+/).filter(Boolean).length,
    });
    expect(report.estimated).toBe(false);
  });

  it("estimates in the right ballpark", () => {
    // Against real BPE tokenizers, structured text of this kind lands near one
    // token per three to five characters. A wildly different ratio means the
    // heuristic drifted.
    const text = 'c metric Metric label="Quarterly revenue" value=4820000\n';
    const ratio = text.length / estimateTokens(text);
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(6);
  });
});
