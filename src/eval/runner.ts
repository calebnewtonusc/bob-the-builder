/**
 * The runner. Executes each scenario N times, measures what came back, and
 * compares it against a committed baseline.
 *
 * The baseline is what makes this a regression gate rather than a dashboard.
 * Generated interfaces drift for reasons that have nothing to do with your code:
 * a model version changes, a prompt gets edited, a component description gets
 * reworded. None of that shows up in a type checker or a unit test, and all of
 * it changes what your users see. Committing the numbers means the drift arrives
 * as a failing check with a diff instead of as a support ticket.
 */

import { buildSystemPrompt } from "../core/prompt.js";
import { BobStream } from "../core/stream.js";
import type { Spec, SurfaceEvent } from "../core/spec.js";
import { estimateTokens } from "../audit/tokens.js";
import type { ModelAdapter } from "./adapter.js";
import { measureStability, type StabilityReport } from "./metrics.js";
import type { AssertionResult, RunResult, Scenario, Suite } from "./scenario.js";

export interface ScenarioReport {
  name: string;
  runs: RunResult[];
  stability: StabilityReport;
  /** Assertion name to how many runs passed it. */
  assertions: {
    name: string;
    passed: number;
    total: number;
    failures: string[];
  }[];
  meanTokens: number;
  meanFirstPaint: number;
  pass: boolean;
  reasons: string[];
}

export interface EvalReport {
  model: string;
  format: string;
  scenarios: ScenarioReport[];
  pass: boolean;
  startedAt: string;
  durationMs: number;
}

/** Run one scenario once and measure it. */
async function runOnce(
  suite: Suite,
  scenario: Scenario,
  adapter: ModelAdapter,
): Promise<RunResult> {
  const system = buildSystemPrompt(suite.catalog, { format: suite.format });

  const warnings: string[] = [];
  let error: string | null = null;
  let firstPaintChars = -1;
  let consumed = 0;

  const stream = new BobStream({
    catalog: suite.catalog,
    format: suite.format,
    mode: "lenient",
    onEvent: (event: SurfaceEvent) => {
      if (event.type === "warn") warnings.push(event.message);
      if (event.type === "error") error = event.message;
      if (event.type === "ready" && firstPaintChars < 0) {
        firstPaintChars = consumed;
      }
    },
  });

  let raw = "";
  try {
    for await (const chunk of adapter.stream(system, scenario.prompt)) {
      raw += chunk;
      consumed += chunk.length;
      stream.push(chunk);
    }
    stream.close();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const spec: Spec = stream.store.snapshot;

  return {
    spec,
    raw,
    warnings,
    error,
    tokens: estimateTokens(raw),
    firstPaintAt: firstPaintChars < 0 || raw.length === 0 ? -1 : firstPaintChars / raw.length,
  };
}

export interface RunOptions {
  adapter: ModelAdapter;
  /** Called after each run, for progress output. */
  onProgress?: (scenario: string, run: number, of: number) => void;
}

export async function runEval(
  suite: Suite,
  opts: RunOptions,
): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const reports: ScenarioReport[] = [];

  for (const scenario of suite.scenarios) {
    const count = scenario.runs ?? suite.runs;
    const runs: RunResult[] = [];

    for (let i = 0; i < count; i++) {
      opts.onProgress?.(scenario.name, i + 1, count);
      runs.push(await runOnce(suite, scenario, opts.adapter));
    }

    const stability = measureStability(runs.map((r) => r.spec));

    const assertions = scenario.expect.map((a) => {
      const results: AssertionResult[] = runs.map((r) =>
        a.check(r, suite.catalog),
      );
      const failures = results.filter((x) => !x.pass).map((x) => x.detail);
      return {
        name: a.name,
        passed: results.filter((x) => x.pass).length,
        total: results.length,
        // One example is enough to debug; a wall of identical details is noise.
        failures: [...new Set(failures)].slice(0, 3),
      };
    });

    const reasons: string[] = [];
    for (const a of assertions) {
      if (a.passed < a.total) {
        reasons.push(
          `${a.name} failed ${a.total - a.passed}/${a.total}: ${a.failures.join("; ")}`,
        );
      }
    }
    if (stability.stability < suite.minStability) {
      reasons.push(
        `stability ${stability.stability.toFixed(2)} below ${suite.minStability}`,
      );
    }

    const mean = (xs: number[]): number =>
      xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

    reports.push({
      name: scenario.name,
      runs,
      stability,
      assertions,
      meanTokens: Math.round(mean(runs.map((r) => r.tokens))),
      meanFirstPaint: mean(runs.map((r) => r.firstPaintAt).filter((x) => x >= 0)),
      pass: reasons.length === 0,
      reasons,
    });
  }

  return {
    model: opts.adapter.name,
    format: suite.format,
    scenarios: reports,
    pass: reports.every((r) => r.pass),
    startedAt,
    durationMs: Date.now() - t0,
  };
}

/* -------------------------------------------------------------------------- */
/* Baselines                                                                  */
/* -------------------------------------------------------------------------- */

export interface Baseline {
  model: string;
  recordedAt: string;
  scenarios: Record<
    string,
    { stability: number; meanTokens: number; meanFirstPaint: number; passed: number }
  >;
}

export function toBaseline(report: EvalReport): Baseline {
  const scenarios: Baseline["scenarios"] = {};
  for (const s of report.scenarios) {
    scenarios[s.name] = {
      stability: Number(s.stability.stability.toFixed(4)),
      meanTokens: s.meanTokens,
      meanFirstPaint: Number(s.meanFirstPaint.toFixed(4)),
      passed: s.assertions.filter((a) => a.passed === a.total).length,
    };
  }
  return { model: report.model, recordedAt: report.startedAt, scenarios };
}

export interface Regression {
  scenario: string;
  metric: string;
  was: number;
  now: number;
  detail: string;
}

export interface BaselineTolerance {
  /** Allowed stability drop before it counts as a regression. */
  stability?: number;
  /** Allowed proportional token growth, e.g. 0.15 for 15%. */
  tokens?: number;
  /** Allowed absolute increase in first-paint fraction. */
  firstPaint?: number;
}

export function compareToBaseline(
  report: EvalReport,
  baseline: Baseline,
  tolerance: BaselineTolerance = {},
): Regression[] {
  const tolStability = tolerance.stability ?? 0.05;
  const tolTokens = tolerance.tokens ?? 0.2;
  const tolPaint = tolerance.firstPaint ?? 0.1;
  const out: Regression[] = [];

  for (const s of report.scenarios) {
    const was = baseline.scenarios[s.name];
    if (!was) continue;

    const nowStability = s.stability.stability;
    if (nowStability < was.stability - tolStability) {
      out.push({
        scenario: s.name,
        metric: "stability",
        was: was.stability,
        now: Number(nowStability.toFixed(4)),
        detail: "the interface moves around more than it used to",
      });
    }

    if (was.meanTokens > 0 && s.meanTokens > was.meanTokens * (1 + tolTokens)) {
      out.push({
        scenario: s.name,
        metric: "tokens",
        was: was.meanTokens,
        now: s.meanTokens,
        detail: "responses got more expensive",
      });
    }

    if (s.meanFirstPaint > was.meanFirstPaint + tolPaint) {
      out.push({
        scenario: s.name,
        metric: "firstPaint",
        was: was.meanFirstPaint,
        now: Number(s.meanFirstPaint.toFixed(4)),
        detail: "the user waits longer before seeing anything",
      });
    }

    const passedNow = s.assertions.filter((a) => a.passed === a.total).length;
    if (passedNow < was.passed) {
      out.push({
        scenario: s.name,
        metric: "assertions",
        was: was.passed,
        now: passedNow,
        detail: "fewer assertions hold than before",
      });
    }
  }

  return out;
}
