/**
 * Check a generated surface against the catalog that was supposed to constrain
 * it. This is the harness half of "test the artifact, never the rationale".
 *
 * The reason it exists: a benchmark of five leading generative UI tools found
 * that over a quarter of the design reasoning they showed the user was absent
 * from what they actually built, and that on functional UX principles four of
 * the five implemented six percent or fewer. The reasoning trace is not
 * evidence. What the model says it did and what arrived on the wire are
 * different objects, and only one of them is testable.
 *
 * So: capture real model output as a fixture, run it through here in CI, and let
 * a regression fail the build rather than reach a user.
 */

import type { Catalog } from "../core/catalog.js";
import type { ComponentId, Op } from "../core/spec.js";
import { SurfaceStore } from "../core/store.js";
import type { Finding, Severity } from "./a11y.js";

/**
 * Text a model emits when it has nothing to say. Catching this is worth more
 * than it looks: placeholder content in a generated interface is indistinguishable
 * from real content to anyone who does not already know the answer.
 */
const PLACEHOLDER_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /lorem\s+ipsum/i, label: "lorem ipsum" },
  { re: /^\s*(item|option|row|column|field|label)\s*\d+\s*$/i, label: "numbered placeholder" },
  { re: /^\s*(todo|tbd|fixme|xxx|placeholder|example|sample|test)\s*$/i, label: "placeholder word" },
  { re: /\byour\s+(name|title|text|content)\s+here\b/i, label: "fill-in-the-blank" },
  { re: /^\s*(foo|bar|baz|qux)\s*$/i, label: "metasyntactic filler" },
];

export interface ValidateOptions {
  /** Fail on placeholder-looking content. Default true. */
  checkPlaceholders?: boolean;
  /** Fail when components are unreachable from the root. Default true. */
  checkReachability?: boolean;
}

export interface ValidateReport {
  findings: Finding[];
  errors: number;
  warnings: number;
  pass: boolean;
  /** Component ids reachable from the root, in render order. */
  order: ComponentId[];
}

export function validateOps(
  catalog: Catalog,
  ops: Op[],
  opts: ValidateOptions = {},
): ValidateReport {
  const checkPlaceholders = opts.checkPlaceholders ?? true;
  const checkReachability = opts.checkReachability ?? true;

  const findings: Finding[] = [];
  const add = (
    severity: Severity,
    rule: string,
    component: string,
    message: string,
    fix?: string,
  ): void => {
    findings.push({ severity, rule, component, message, ...(fix ? { fix } : {}) });
  };

  const store = new SurfaceStore({
    catalog,
    mode: "lenient",
    onEvent: (event) => {
      if (event.type === "warn") add("warn", "store", "(stream)", event.message);
      if (event.type === "error") add("error", "store", "(stream)", event.message);
    },
  });

  store.apply(ops);
  const spec = store.snapshot;

  if (!spec.root) {
    add(
      "error",
      "no-root",
      "(surface)",
      "The stream never declared a root, so nothing would render.",
      "Emit `r <id>` naming the outermost component.",
    );
    return { findings, errors: countBy(findings, "error"), warnings: countBy(findings, "warn"), pass: false, order: [] };
  }

  if (!spec.elements[spec.root]) {
    add(
      "error",
      "root-missing",
      spec.root,
      `Root ${spec.root} was declared but the component never arrived.`,
    );
  }

  const { order, cycles } = store.resolve();

  for (const id of cycles) {
    add(
      "error",
      "cycle",
      id,
      `Component ${id} is its own ancestor. The renderer cuts the cycle, so part of the surface is silently missing.`,
    );
  }

  // A child id can be missing two ways: it was never declared at all, or a
  // `children` op created a placeholder waiting for it. The store's pending set
  // covers both, where scanning `elements` alone only finds the second.
  for (const id of store.pendingIds) {
    add(
      "error",
      "dangling-child",
      id,
      "Referenced as a child but never declared, so a skeleton is shown where content should be.",
      "Emit the component, or stop listing it as a child.",
    );
  }

  if (checkReachability) {
    const reachable = new Set(order);
    const pending = new Set(store.pendingIds);
    for (const id of Object.keys(spec.elements)) {
      const node = spec.elements[id]!;
      if (node.type === "__pending__") continue;
      if (!reachable.has(id) && !pending.has(id)) {
        add(
          "warn",
          "unreachable",
          id,
          `Declared but not reachable from the root, so the tokens spent on it were wasted.`,
          "Add it to a parent's children, or stop emitting it.",
        );
      }
    }
  }

  for (const id of order) {
    const node = spec.elements[id]!;
    const def = catalog.get(node.type);
    if (!def) continue;

    if (checkPlaceholders) {
      for (const [key, value] of Object.entries(node.props)) {
        if (typeof value !== "string") continue;
        for (const { re, label } of PLACEHOLDER_PATTERNS) {
          if (re.test(value)) {
            add(
              "error",
              "placeholder-content",
              id,
              `Prop ${key} contains ${label}: ${JSON.stringify(value)}.`,
              "Generated interfaces must carry real content. A user cannot tell filler from an answer.",
            );
            break;
          }
        }
      }
    }

    // A component that gets its accessible name from a prop, without that prop,
    // is the "button labelled button" failure, caught before it renders.
    if (def.a11y.name.from === "prop") {
      const nameProp = def.a11y.name.prop;
      const value = node.props[nameProp];
      const missing =
        value === undefined ||
        (typeof value === "string" && value.trim() === "");
      if (missing) {
        add(
          "error",
          "missing-accessible-name",
          id,
          `${node.type} takes its accessible name from ${nameProp}, which is empty or absent.`,
          `A screen reader would announce only the role. Set ${nameProp}.`,
        );
      }
    }

    if (def.children?.length === 0 && node.children.length > 0) {
      add(
        "warn",
        "leaf-with-children",
        id,
        `${node.type} is a leaf in the catalog but was given ${node.children.length} children, which will not render.`,
      );
    }
  }

  const errors = countBy(findings, "error");
  const warnings = countBy(findings, "warn");
  return { findings, errors, warnings, pass: errors === 0, order };
}

function countBy(findings: Finding[], severity: Severity): number {
  return findings.filter((f) => f.severity === severity).length;
}
