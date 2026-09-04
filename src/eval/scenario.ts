/**
 * Scenarios and assertions.
 *
 * An assertion runs against what actually arrived on the wire, never against
 * anything the model said about its own work. That distinction is the entire
 * reason this file exists: a 2026 benchmark of five leading generative UI tools
 * found over a quarter of their stated design reasoning absent from what they
 * built, and on functional UX principles four of the five implemented six
 * percent or fewer. The reasoning trace is marketing aimed at you.
 *
 * So every assertion below is a structural claim about the spec, checkable
 * without a model in the loop and identical on every machine.
 */

import type { Catalog } from "../core/catalog.js";
import type { Spec } from "../core/spec.js";
import type { WireFormat } from "../core/stream.js";
import { componentCount, componentCounts, treeDepth } from "./metrics.js";

export interface RunResult {
  spec: Spec;
  /** Raw text the model produced. */
  raw: string;
  /** Warnings the store emitted while assembling. */
  warnings: string[];
  /** Fatal error, if the surface never assembled. */
  error: string | null;
  /** Estimated tokens in the response. */
  tokens: number;
  /**
   * Fraction of the stream consumed when the root resolved and the first paint
   * became possible. 0.05 means the user saw something after 5% of the response.
   */
  firstPaintAt: number;
}

export interface AssertionResult {
  pass: boolean;
  detail: string;
}

export interface Assertion {
  name: string;
  check(result: RunResult, catalog: Catalog): AssertionResult;
}

export interface Scenario {
  name: string;
  /** The user's request, appended to the generated system prompt. */
  prompt: string;
  expect: Assertion[];
  /** Override the suite's run count for this scenario. */
  runs?: number;
}

export interface SuiteInit {
  catalog: Catalog;
  scenarios: Scenario[];
  /** Times to run each scenario. Stability needs at least 3 to mean anything. */
  runs?: number;
  format?: WireFormat;
  /** Minimum stability before a scenario is considered a failure. */
  minStability?: number;
}

export interface Suite extends SuiteInit {
  runs: number;
  format: WireFormat;
  minStability: number;
}

export function defineScenarios(init: SuiteInit): Suite {
  if (init.scenarios.length === 0) {
    throw new Error("A suite needs at least one scenario.");
  }
  const runs = init.runs ?? 5;
  if (runs < 1) throw new Error("runs must be at least 1.");
  return {
    ...init,
    runs,
    format: init.format ?? "lines",
    minStability: init.minStability ?? 0.8,
  };
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

function assertion(
  name: string,
  check: (result: RunResult, catalog: Catalog) => AssertionResult,
): Assertion {
  return { name, check };
}

const ok = (detail: string): AssertionResult => ({ pass: true, detail });
const no = (detail: string): AssertionResult => ({ pass: false, detail });

/** The interface must contain at least one of this component. */
export function usesComponent(type: string, atLeast = 1): Assertion {
  return assertion(`uses ${type}${atLeast > 1 ? ` ×${atLeast}` : ""}`, (r) => {
    const n = componentCounts(r.spec).get(type) ?? 0;
    return n >= atLeast
      ? ok(`${n} present`)
      : no(`expected at least ${atLeast}, found ${n}`);
  });
}

/**
 * The interface must not reach for this component.
 *
 * The usual use is `avoidsComponent("Text")` on a scenario whose answer is a
 * comparison: a model that describes a table in prose has technically answered
 * and has actually failed.
 */
export function avoidsComponent(type: string): Assertion {
  return assertion(`avoids ${type}`, (r) => {
    const n = componentCounts(r.spec).get(type) ?? 0;
    return n === 0 ? ok("absent") : no(`found ${n}`);
  });
}

/** At least one of these components must appear. */
export function usesOneOf(types: string[]): Assertion {
  return assertion(`uses one of ${types.join("/")}`, (r) => {
    const counts = componentCounts(r.spec);
    const found = types.filter((t) => (counts.get(t) ?? 0) > 0);
    return found.length > 0
      ? ok(`found ${found.join(", ")}`)
      : no(`none of ${types.join(", ")} present`);
  });
}

export function maxDepth(limit: number): Assertion {
  return assertion(`depth ≤ ${limit}`, (r) => {
    const d = treeDepth(r.spec);
    return d <= limit ? ok(`depth ${d}`) : no(`depth ${d}, over ${limit}`);
  });
}

export function maxComponents(limit: number): Assertion {
  return assertion(`≤ ${limit} components`, (r) => {
    const n = componentCount(r.spec);
    return n <= limit ? ok(`${n} components`) : no(`${n}, over ${limit}`);
  });
}

export function maxTokens(limit: number): Assertion {
  return assertion(`≤ ${limit} tokens`, (r) =>
    r.tokens <= limit ? ok(`${r.tokens} tokens`) : no(`${r.tokens}, over ${limit}`),
  );
}

/**
 * The root must resolve within this fraction of the stream.
 *
 * A model that emits the root op last produces one paint at the very end, which
 * measured 23x worse time to first paint than the same response with the root
 * claimed second. This is the assertion that catches a prompt regression putting
 * it back.
 */
export function firstPaintUnder(fraction: number): Assertion {
  return assertion(`first paint < ${Math.round(fraction * 100)}% of stream`, (r) => {
    if (r.firstPaintAt < 0) return no("never painted");
    const pct = Math.round(r.firstPaintAt * 100);
    return r.firstPaintAt <= fraction
      ? ok(`painted at ${pct}%`)
      : no(`painted at ${pct}%, over ${Math.round(fraction * 100)}%`);
  });
}

/** Every interactive component carries a non-empty accessible name. */
export function allInteractiveNamed(): Assertion {
  return assertion("interactive components are named", (r, catalog) => {
    const unnamed: string[] = [];
    for (const node of Object.values(r.spec.elements)) {
      const def = catalog.get(node.type);
      if (!def || def.a11y.name.from !== "prop") continue;
      const value = node.props[def.a11y.name.prop];
      if (value === undefined || (typeof value === "string" && !value.trim())) {
        unnamed.push(`${node.type}#${node.id}`);
      }
    }
    return unnamed.length === 0
      ? ok("all named")
      : no(`unnamed: ${unnamed.join(", ")}`);
  });
}

const PLACEHOLDER =
  /lorem\s+ipsum|^\s*(item|option|row|field)\s*\d+\s*$|^\s*(todo|tbd|placeholder|example|sample)\s*$|your\s+\w+\s+here|^\s*(foo|bar|baz)\s*$/i;

/** No filler content. A user cannot tell filler from an answer. */
export function noPlaceholders(): Assertion {
  return assertion("no placeholder content", (r) => {
    const found: string[] = [];
    for (const node of Object.values(r.spec.elements)) {
      for (const [key, value] of Object.entries(node.props)) {
        if (typeof value === "string" && PLACEHOLDER.test(value)) {
          found.push(`${node.type}.${key}=${JSON.stringify(value)}`);
        }
      }
    }
    return found.length === 0 ? ok("clean") : no(found.join("; "));
  });
}

/** The store assembled the surface without complaining. */
export function noWarnings(): Assertion {
  return assertion("no store warnings", (r) =>
    r.warnings.length === 0
      ? ok("clean")
      : no(`${r.warnings.length}: ${r.warnings[0]}`),
  );
}

/** The surface assembled at all. */
export function renders(): Assertion {
  return assertion("renders", (r) =>
    r.error === null && r.spec.root !== null
      ? ok("root resolved")
      : no(r.error ?? "no root"),
  );
}

/** A value exists at this pointer in the data model. */
export function bindsData(pointer: string): Assertion {
  return assertion(`binds ${pointer}`, (r) => {
    const bound = Object.values(r.spec.elements).some((node) =>
      Object.values(node.props).some(
        (v) => typeof v === "object" && v !== null && "$bind" in v && v.$bind === pointer,
      ),
    );
    return bound ? ok("bound") : no(`nothing bound to ${pointer}`);
  });
}

/** Free-form escape hatch for a claim the built-ins do not cover. */
export function custom(
  name: string,
  check: (result: RunResult, catalog: Catalog) => boolean | AssertionResult,
): Assertion {
  return assertion(name, (r, c) => {
    const out = check(r, c);
    return typeof out === "boolean"
      ? out
        ? ok("passed")
        : no("failed")
      : out;
  });
}
