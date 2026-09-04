#!/usr/bin/env node
/**
 * bob — catalog auditing from the command line.
 *
 *   bob audit  <catalog>              accessibility and prompt-quality review
 *   bob check  <catalog> <fixture>    validate captured model output
 *   bob tokens <catalog> <fixture>    what each wire format costs
 *   bob prompt <catalog> [--format]   print the generated system prompt
 *
 * The catalog module must export a Bob catalog as `catalog` or as its default
 * export. TypeScript catalogs work when this is run through tsx.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Catalog } from "../core/catalog.js";
import type { Op } from "../core/spec.js";
import { parseLines } from "../core/lines.js";
import { buildSystemPrompt } from "../core/prompt.js";
import type { WireFormat } from "../core/stream.js";
import { auditA11y, type Finding } from "./a11y.js";
import { auditTokens } from "./tokens.js";
import { validateOps } from "./validate.js";

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

async function loadCatalog(path: string): Promise<Catalog> {
  const url = pathToFileURL(resolve(process.cwd(), path)).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (path.endsWith(".ts")) {
      fail(
        `Could not import ${path}.\n${message}\n\n` +
          `TypeScript catalogs need a loader. Try:\n  npx tsx node_modules/weft/dist/audit/cli.js ${process.argv.slice(2).join(" ")}`,
      );
    }
    fail(`Could not import ${path}.\n${message}`);
  }
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

const USAGE = `bob — generative UI catalog auditing

  bob audit  <catalog>              accessibility and prompt-quality review
  bob check  <catalog> <fixture>    validate captured model output
  bob tokens <catalog> <fixture>    what each wire format costs
  bob prompt <catalog> [--format lines|jsonl|json]

The catalog module exports a catalog as \`catalog\` or as its default export.
A fixture is .bl (Bob Lines), .jsonl, or .json.

Exit code is 1 when there are errors, so this drops into CI as-is.`;

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

    default:
      fail(`Unknown command ${JSON.stringify(command)}.\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
