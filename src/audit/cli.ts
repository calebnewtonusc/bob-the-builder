#!/usr/bin/env node
/**
 * bob — generative UI catalogs, audited and evaluated, from the command line.
 *
 *   bob eval   <suite> [--update]     run scenarios, measure stability, gate on it
 *   bob audit  <catalog>              accessibility and prompt-quality review
 *   bob check  <catalog> <fixture>    validate captured model output
 *   bob tokens <catalog> <fixture>    what each wire format costs
 *   bob prompt <catalog> [--format]   print the generated system prompt
 *
 * The catalog module must export a Bob catalog as `catalog` or as its default
 * export. TypeScript catalogs work when this is run through tsx.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import type { Catalog } from "../core/catalog.js";
import type { Op } from "../core/spec.js";
import { parseLines } from "../core/lines.js";
import { buildSystemPrompt } from "../core/prompt.js";
import type { WireFormat } from "../core/stream.js";
import { auditA11y, type Finding } from "./a11y.js";
import { auditTokens } from "./tokens.js";
import { validateOps } from "./validate.js";
import {
  compareToBaseline,
  runEval,
  toBaseline,
  type Baseline,
  type EvalReport,
  type ModelAdapter,
  type Suite,
} from "../eval/index.js";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const MARK: Record<string, (s: string) => string> = {
  error: c.red,
  warn: c.yellow,
  info: c.blue,
};

async function loadModule(path: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(resolve(process.cwd(), path)).href;
  try {
    return (await import(url)) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (path.endsWith(".ts")) {
      fail(
        `Could not import ${path}.\n${message}\n\n` +
          `TypeScript files need a loader. Try:\n  npx tsx node_modules/bobthebuilder/dist/audit/cli.js ${process.argv.slice(2).join(" ")}`,
      );
    }
    fail(`Could not import ${path}.\n${message}`);
  }
}

function bar(value: number, width = 12): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width);
  const paint = value >= 0.9 ? c.green : value >= 0.7 ? c.yellow : c.red;
  return paint("█".repeat(filled)) + c.dim("░".repeat(width - filled));
}

function printEval(report: EvalReport, minStability: number): void {
  for (const s of report.scenarios) {
    const mark = s.pass ? c.green("✓") : c.red("✗");
    console.log(`\n  ${mark} ${c.bold(s.name)}`);
    console.log(
      `    stability  ${bar(s.stability.stability)} ${s.stability.stability.toFixed(2)}` +
        c.dim(`  (min ${minStability})`),
    );
    console.log(
      c.dim(
        `      components ${s.stability.components.toFixed(2)}` +
          `  shape ${s.stability.shape.toFixed(2)}` +
          `  depth ${s.stability.depth.toFixed(2)}`,
      ),
    );

    if (s.stability.variants.length > 1) {
      console.log(c.dim(`      ${s.stability.variants.length} distinct layouts across ${s.stability.runs} runs:`));
      for (const v of s.stability.variants.slice(0, 3)) {
        console.log(c.dim(`        ${v.runs}× ${v.signature.slice(0, 68)}`));
      }
    }

    console.log(
      c.dim(
        `    cost       ${s.meanTokens} tokens` +
          `   first paint at ${Math.round(s.meanFirstPaint * 100)}% of stream`,
      ),
    );

    for (const a of s.assertions) {
      const all = a.passed === a.total;
      const paint = all ? c.green : c.red;
      console.log(
        `    ${paint(all ? "✓" : "✗")} ${a.name} ${c.dim(`${a.passed}/${a.total}`)}`,
      );
      if (!all && a.failures.length > 0) {
        for (const f of a.failures) console.log(c.dim(`        ${f}`));
      }
    }
  }

  const passed = report.scenarios.filter((s) => s.pass).length;
  console.log(
    `\n  ${passed}/${report.scenarios.length} scenarios pass` +
      c.dim(`  ·  ${(report.durationMs / 1000).toFixed(1)}s`),
  );
}

async function readBaseline(path: string): Promise<Baseline | null> {
  try {
    return JSON.parse(await readFile(resolve(process.cwd(), path), "utf8")) as Baseline;
  } catch {
    return null;
  }
}

async function writeBaseline(path: string, report: EvalReport): Promise<void> {
  const target = resolve(process.cwd(), path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(toBaseline(report), null, 2) + "\n");
}

async function loadCatalog(path: string): Promise<Catalog> {
  const mod = await loadModule(path);
  const found = (mod["catalog"] ?? mod["default"]) as Catalog | undefined;
  if (!found || typeof found !== "object" || !("componentNames" in found)) {
    fail(
      `${path} does not export a Bob catalog.\n` +
        `Export it as \`catalog\` or as the default export, built with defineCatalog().`,
    );
  }
  return found;
}

async function loadFixture(path: string): Promise<Op[]> {
  const text = await readFile(resolve(process.cwd(), path), "utf8");
  if (path.endsWith(".json")) return JSON.parse(text) as Op[];
  if (path.endsWith(".jsonl")) {
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => JSON.parse(l) as Op);
  }
  return parseLines(text);
}

function printFindings(findings: Finding[]): void {
  if (findings.length === 0) {
    console.log(c.green("  No findings."));
    return;
  }
  const byComponent = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byComponent.get(f.component) ?? [];
    list.push(f);
    byComponent.set(f.component, list);
  }
  for (const [component, list] of byComponent) {
    console.log(`\n  ${c.bold(component)}`);
    for (const f of list) {
      const paint = MARK[f.severity] ?? ((s: string) => s);
      console.log(`    ${paint(f.severity.padEnd(5))} ${f.message}`);
      console.log(`          ${c.dim(f.rule)}`);
      if (f.fix) console.log(`          ${c.dim("fix: " + f.fix)}`);
    }
  }
}

function fail(message: string): never {
  console.error(c.red("error: ") + message);
  process.exit(1);
}

function summary(errors: number, warnings: number, infos = 0): void {
  const parts: string[] = [];
  if (errors) parts.push(c.red(`${errors} error${errors === 1 ? "" : "s"}`));
  if (warnings) parts.push(c.yellow(`${warnings} warning${warnings === 1 ? "" : "s"}`));
  if (infos) parts.push(c.blue(`${infos} note${infos === 1 ? "" : "s"}`));
  console.log("\n" + (parts.length ? parts.join(", ") : c.green("clean")));
}

const USAGE = `bob — generative UI catalogs, audited and evaluated

  bob eval   <suite> [--update]     run scenarios, measure stability, gate on it
  bob audit  <catalog>              accessibility and prompt-quality review
  bob check  <catalog> <fixture>    validate captured model output
  bob tokens <catalog> <fixture>    what each wire format costs
  bob prompt <catalog> [--format lines|jsonl|json]

A catalog module exports a catalog as \`catalog\` or as its default export.
An eval suite exports a suite as \`suite\` or default, plus an \`adapter\`.
A fixture is .bl (Bob Lines), .jsonl, or .json.

  --update     rewrite the baseline instead of comparing against it
  --baseline   path to the baseline file (default .bob/baseline.json)

Exit code is 1 when there are errors, so all of this drops into CI as-is.`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "audit": {
      const path = args[0];
      if (!path) fail("bob audit needs a catalog path.");
      const catalog = await loadCatalog(path);
      console.log(
        `\n${c.bold(catalog.name)} ${c.dim(`· ${catalog.componentNames.length} components, ${catalog.actionNames.length} actions`)}`,
      );
      const report = auditA11y(catalog);
      printFindings(report.findings);
      summary(report.errors, report.warnings, report.infos);
      if (!report.pass) process.exit(1);
      return;
    }

    case "check": {
      const [path, fixture] = args;
      if (!path || !fixture) fail("bob check needs a catalog path and a fixture path.");
      const catalog = await loadCatalog(path);
      const ops = await loadFixture(fixture);
      console.log(`\n${c.bold(fixture)} ${c.dim(`· ${ops.length} operations`)}`);
      const report = validateOps(catalog, ops);
      printFindings(report.findings);
      console.log(
        `\n  ${c.dim(`${report.order.length} components reachable from root`)}`,
      );
      summary(report.errors, report.warnings);
      if (!report.pass) process.exit(1);
      return;
    }

    case "tokens": {
      const [path, fixture] = args;
      if (!path || !fixture) fail("bob tokens needs a catalog path and a fixture path.");
      await loadCatalog(path);
      const ops = await loadFixture(fixture);
      const report = auditTokens(fixture, ops);

      console.log(`\n${c.bold("Wire format cost")} ${c.dim(`· ${report.scenario}`)}\n`);
      console.log(
        c.dim("  format   tokens    bytes    ratio    seconds @ " + report.tokensPerSecond + " tok/s"),
      );
      for (const cost of report.costs) {
        const mark = cost.format === report.cheapest ? c.green("✓") : " ";
        console.log(
          `  ${mark} ${cost.format.padEnd(7)}` +
            `${String(cost.tokens).padStart(6)}` +
            `${String(cost.bytes).padStart(9)}` +
            `${cost.ratio.toFixed(2).padStart(9)}×` +
            `${cost.seconds.toFixed(1).padStart(10)}s`,
        );
      }
      console.log(
        `\n  ${c.bold(report.spread.toFixed(2) + "×")} spread between cheapest and priciest.`,
      );
      if (report.estimated) {
        console.log(
          c.dim(
            "\n  Counts are heuristic, within roughly 10% on structured text.\n" +
              "  The ratio is the durable number: formats differ mostly in punctuation,\n" +
              "  and every tokenizer charges for punctuation. Pass your own tokenizer\n" +
              "  to auditTokens({ count }) for exact figures.",
          ),
        );
      }
      return;
    }

    case "prompt": {
      const path = args[0];
      if (!path) fail("bob prompt needs a catalog path.");
      const idx = args.indexOf("--format");
      const format = (idx !== -1 ? args[idx + 1] : "lines") as WireFormat;
      if (!["lines", "jsonl", "json"].includes(format)) {
        fail(`Unknown format ${JSON.stringify(format)}. Use lines, jsonl, or json.`);
      }
      const catalog = await loadCatalog(path);
      console.log(buildSystemPrompt(catalog, { format }));
      return;
    }

    case "eval": {
      const path = args[0];
      if (!path) fail("bob eval needs a suite path.");
      const update = args.includes("--update");
      const bIdx = args.indexOf("--baseline");
      const baselinePath =
        bIdx !== -1 ? args[bIdx + 1]! : ".bob/baseline.json";

      const mod = await loadModule(path);
      const suite = (mod["suite"] ?? mod["default"]) as Suite | undefined;
      const adapter = mod["adapter"] as ModelAdapter | undefined;
      if (!suite || !("scenarios" in suite)) {
        fail(`${path} does not export a suite. Export it as \`suite\` or default.`);
      }
      if (!adapter || typeof adapter.stream !== "function") {
        fail(
          `${path} does not export a model adapter.\n` +
            `Export \`adapter\`, built with defineAdapter() or replayAdapter().`,
        );
      }

      console.log(
        `\n${c.bold(suite.catalog.name)} ${c.dim(`· ${suite.scenarios.length} scenarios × ${suite.runs} runs · ${adapter.name}`)}`,
      );

      const report = await runEval(suite, {
        adapter,
        onProgress: (name, run, of) => {
          process.stderr.write(`\r  ${name} ${run}/${of}   `);
        },
      });
      process.stderr.write("\r" + " ".repeat(60) + "\r");

      printEval(report, suite.minStability);

      if (update) {
        await writeBaseline(baselinePath, report);
        console.log(c.dim(`\n  baseline written to ${baselinePath}`));
        if (!report.pass) process.exit(1);
        return;
      }

      const baseline = await readBaseline(baselinePath);
      if (!baseline) {
        console.log(
          c.dim(`\n  No baseline at ${baselinePath}. Run with --update to record one.`),
        );
      } else {
        const regressions = compareToBaseline(report, baseline);
        if (regressions.length === 0) {
          console.log(c.green("\n  No regression against baseline."));
        } else {
          console.log(c.red(`\n  ${regressions.length} regression(s) against baseline:\n`));
          for (const r of regressions) {
            console.log(
              `    ${c.bold(r.scenario)} ${r.metric}: ${r.was} → ${c.red(String(r.now))}`,
            );
            console.log(`      ${c.dim(r.detail)}`);
          }
          process.exit(1);
        }
      }

      if (!report.pass) process.exit(1);
      return;
    }

    default:
      fail(`Unknown command ${JSON.stringify(command)}.\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
