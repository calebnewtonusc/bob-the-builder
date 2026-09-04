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
  CommandError,
  cmdAdd,
  cmdChange,
  cmdClear,
  cmdList,
  cmdLog,
  cmdMake,
  cmdOpen,
  cmdRemove,
  cmdSet,
  cmdShare,
  cmdHud,
} from "../app/cli-commands.js";
import { hydrate, loadApp } from "../app/index.js";
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

const USAGE = `bob — software that gets built once and stays built

Apps you own. The model authors them; after that they run on their own with no
model, no network, and no tokens, and look the same every time.

  bob make   "<what you want>"      build a new app
  bob open   <app>                  run it
  bob set    <app> <field> <value>  fill in a field
  bob add    <app>                  save the record you are filling in
  bob rm     <app> <#>              delete a record

  --in <list>  which list, for an app with more than one
  --force      let make replace an existing app, losing its records
  bob change <app> "<what to fix>"  patch the interface, keep the data
  bob share  <app> [file.html]      one HTML file you can send to anyone
  bob hud    "<question>"           draw an answer on the floating panel
  bob hud    <file.bl> --file       pipe Bob Lines straight to the panel
  bob list                          every app you have
  bob log    <app>                  what changed and when

Build-time tools, for people making catalogs:

  bob eval   <suite> [--update]     run scenarios, measure stability, gate on it
  bob audit  <catalog>              accessibility and prompt-quality review
  bob check  <catalog> <fixture>    validate captured model output
  bob tokens <catalog> <fixture>    what each wire format costs
  bob prompt <catalog> [--format lines|jsonl|json]

Apps live in ~/.bob/apps as plain JSON. Set BOB_WORKSPACE to move them.
\`make\` and \`change\` need a model: set BOB_MODEL_CMD to a command that reads a
prompt on stdin and writes the answer to stdout, or pass --adapter <module>.

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

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const opts = {
    dir: flag("workspace"),
    adapter: flag("adapter"),
    in: flag("in"),
    force: args.includes("--force"),
  };
  const positional = args.filter((a, i) => {
    if (a.startsWith("--")) return false;
    const prev = args[i - 1];
    return !(
      prev === "--workspace" ||
      prev === "--adapter" ||
      prev === "--baseline" ||
      prev === "--in"
    );
  });

  switch (command) {
    case "make": {
      const request = positional.join(" ");
      if (!request) fail('bob make needs a description, e.g. bob make "a reading log"');
      await cmdMake(request, opts);
      return;
    }

    case "open": {
      const id = positional[0];
      if (!id) fail("bob open needs an app name. Try: bob list");
      cmdOpen(hydrate(await loadApp(id, opts.dir)));
      return;
    }

    case "set": {
      const [id, field, ...rest] = positional;
      if (!id || !field || rest.length === 0) {
        fail("bob set needs an app, a field, and a value.");
      }
      await cmdSet(id, field, rest.join(" "), opts);
      return;
    }

    case "add": {
      const id = positional[0];
      if (!id) fail("bob add needs an app name.");
      await cmdAdd(id, opts);
      return;
    }

    case "rm": {
      const [id, index] = positional;
      if (!id || index === undefined) fail("bob rm needs an app name and a row number.");
      const n = Number(index);
      if (!Number.isInteger(n)) fail(`${index} is not a row number.`);
      await cmdRemove(id, n, opts);
      return;
    }

    case "clear": {
      const id = positional[0];
      if (!id) fail("bob clear needs an app name.");
      await cmdClear(id, opts);
      return;
    }

    case "change": {
      const [id, ...rest] = positional;
      if (!id || rest.length === 0) {
        fail('bob change needs an app and what to change, e.g. bob change log "add a notes column"');
      }
      await cmdChange(id, rest.join(" "), opts);
      return;
    }

    case "list":
      await cmdList(opts);
      return;

    case "hud": {
      const file = args.includes("--file");
      const request = positional.join(" ");
      if (!request) {
        fail('bob hud needs a request, e.g. bob hud "how many applications am I waiting on"');
      }
      await cmdHud(request, { adapter: opts.adapter, file });
      return;
    }

    case "share": {
      const [id, target] = positional;
      if (!id) fail("bob share needs an app name.");
      await cmdShare(id, target, opts);
      return;
    }

    case "log": {
      const id = positional[0];
      if (!id) fail("bob log needs an app name.");
      await cmdLog(id, opts);
      return;
    }

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
  // A person typing `bob add` should get a sentence, not a stack trace. Only
  // genuinely unexpected failures print the whole thing.
  const friendly = new Set(["AppFormatError",
    "AuthorError",
    "LineParseError",
    "AppExistsError",
    "AppLockedError",
    "AppError"]);
  if (err instanceof CommandError || (err instanceof Error && friendly.has(err.name))) {
    console.error("\n" + c.red("  " + err.message) + "\n");
    process.exit(1);
  }
  if (err instanceof Error && /No app called|does not export/.test(err.message)) {
    console.error("\n" + c.red("  " + err.message) + "\n");
    process.exit(1);
  }
  // Anything left is a genuine surprise. A filesystem code still gets a
  // sentence, because a full disk is not a bug report.
  const code = (err as { code?: string })?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
    console.error(
      "\n" + c.red(`  ${code}: ${err instanceof Error ? err.message : String(err)}`) + "\n",
    );
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
