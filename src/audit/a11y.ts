/**
 * Accessibility checks that run against the catalog, before anything renders.
 *
 * This is the one real leverage point in generative UI accessibility, and the
 * reason it works is arithmetic: a catalog has maybe thirty components and they
 * are the same thirty on every request, so checking one component checks every
 * interface that will ever be built from it. Auditing generated HTML instead
 * means auditing an artifact that did not exist a second ago and will never
 * exist again.
 *
 * Nothing here inspects rendered output, so nothing here is a substitute for
 * testing with an actual screen reader. What it does is make the class of
 * failure that shows up in every audit of generated interfaces, a control whose
 * only accessible name is "button", impossible to ship by construction.
 */

import type { A11ySpec, Catalog, ComponentDef } from "../core/catalog.js";
import type { z } from "zod";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  severity: Severity;
  rule: string;
  component: string;
  message: string;
  fix?: string;
}

/**
 * ARIA roles that a keyboard user must be able to reach and operate. Not the
 * full role list: the ones where getting it wrong locks someone out.
 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "treeitem",
]);

/** Roles that must carry an accessible name even though they are not operable. */
const NAME_REQUIRED_ROLES = new Set([
  "img",
  "figure",
  "table",
  "grid",
  "region",
  "form",
  "dialog",
  "alertdialog",
  "navigation",
  "meter",
  "progressbar",
]);

/** Roles whose content changes and therefore needs announcing. */
const LIVE_EXPECTED_ROLES = new Set(["status", "alert", "log", "progressbar", "meter"]);

const KNOWN_ROLES = new Set([
  ...INTERACTIVE_ROLES,
  ...NAME_REQUIRED_ROLES,
  ...LIVE_EXPECTED_ROLES,
  "group",
  "list",
  "listitem",
  "row",
  "cell",
  "columnheader",
  "rowheader",
  "heading",
  "paragraph",
  "separator",
  "presentation",
  "none",
  "generic",
  "article",
  "banner",
  "complementary",
  "contentinfo",
  "main",
  "tablist",
  "tabpanel",
  "toolbar",
  "tooltip",
  "menu",
  "menubar",
  "tree",
  "treegrid",
  "definition",
  "term",
  "note",
  "math",
  "time",
]);

function schemaKeys(schema: z.ZodTypeAny): string[] {
  const shapeSrc = (schema as unknown as { _def?: Record<string, unknown> })._def?.[
    "shape"
  ];
  const shape =
    typeof shapeSrc === "function"
      ? (shapeSrc as () => Record<string, unknown>)()
      : (shapeSrc as Record<string, unknown> | undefined);
  return shape ? Object.keys(shape) : [];
}

function checkComponent(name: string, def: ComponentDef): Finding[] {
  const found: Finding[] = [];
  const a11y: A11ySpec = def.a11y;
  const role = a11y.role;
  const isInteractive = role !== undefined && INTERACTIVE_ROLES.has(role);

  const add = (
    severity: Severity,
    rule: string,
    message: string,
    fix?: string,
  ): void => {
    found.push({ severity, rule, component: name, message, ...(fix ? { fix } : {}) });
  };

  if (role !== undefined && !KNOWN_ROLES.has(role)) {
    add(
      "warn",
      "unknown-role",
      `Declares role ${JSON.stringify(role)}, which is not a role this auditor recognises.`,
      "Check it against the ARIA spec, or drop it if the element has an implicit role.",
    );
  }

  if (isInteractive && a11y.name.from === "none") {
    add(
      "error",
      "interactive-needs-name",
      `Role ${role} is operable but declares no accessible name.`,
      `Set a11y.name to { from: "prop", prop: "label" } and make that prop required.`,
    );
  }

  if (isInteractive && a11y.keyboard === false) {
    add(
      "error",
      "interactive-needs-keyboard",
      `Role ${role} is operable but declares keyboard: false.`,
      "Make it focusable and operable by keyboard, or change the role.",
    );
  }

  if (isInteractive && a11y.keyboard === undefined) {
    add(
      "warn",
      "keyboard-undeclared",
      `Role ${role} is operable and does not declare keyboard support either way.`,
      "Set a11y.keyboard explicitly so this is a decision rather than an omission.",
    );
  }

  if (role !== undefined && NAME_REQUIRED_ROLES.has(role) && a11y.name.from === "none") {
    add(
      "error",
      "role-needs-name",
      `Role ${role} requires an accessible name and declares none.`,
      "Name it from a prop, or use a presentational role if it is decorative.",
    );
  }

  if (a11y.name.from === "prop") {
    const keys = schemaKeys(def.props);
    if (keys.length > 0 && !keys.includes(a11y.name.prop)) {
      add(
        "error",
        "name-prop-missing",
        `Accessible name comes from prop ${JSON.stringify(a11y.name.prop)}, which is not in the props schema.`,
        `Add ${a11y.name.prop} to the schema, or point a11y.name at a prop that exists.`,
      );
    }
  }

  if (role !== undefined && LIVE_EXPECTED_ROLES.has(role) && !a11y.live) {
    add(
      "warn",
      "live-expected",
      `Role ${role} exists to report changing state but declares no live politeness.`,
      `Set a11y.live to "polite", or "assertive" only if it interrupts a task.`,
    );
  }

  if (a11y.live === "assertive") {
    add(
      "info",
      "assertive-interrupts",
      "Declares assertive, which interrupts whatever the user is currently hearing.",
      "Reserve assertive for errors and use polite for everything else.",
    );
  }

  if (!def.skeleton) {
    add(
      "warn",
      "no-skeleton",
      "No skeleton declared, so a placeholder cannot match its typography.",
      `Add skeleton: { shape: "text", lines: 1 }, or { shape: "none" } for a container.`,
    );
  }

  if (def.describe.trim().length < 12) {
    add(
      "warn",
      "thin-description",
      "The description is too short for a model to choose this component reliably.",
      "Say what it is for and when to pick it over its nearest neighbour.",
    );
  }

  if (!def.examples || def.examples.length === 0) {
    add(
      "info",
      "no-examples",
      "No examples, so the prompt can only describe this component abstractly.",
      "Two realistic examples move generation quality more than any prose.",
    );
  }

  return found;
}

export interface A11yReport {
  findings: Finding[];
  errors: number;
  warnings: number;
  infos: number;
  /** True when there are no errors. Warnings do not fail the audit. */
  pass: boolean;
}

export function auditA11y(catalog: Catalog): A11yReport {
  const findings: Finding[] = [];

  for (const name of catalog.componentNames) {
    findings.push(...checkComponent(name, catalog.components[name]!));
  }

  // A catalog with no way to announce anything cannot report a result to a
  // screen reader user, no matter how well each component behaves alone.
  const hasLive = catalog.componentNames.some(
    (n) => catalog.components[n]!.a11y.live !== undefined,
  );
  if (!hasLive && catalog.componentNames.length > 0) {
    findings.push({
      severity: "warn",
      rule: "catalog-no-live",
      component: "(catalog)",
      message:
        "No component declares a live region, so nothing in this catalog can announce a result as it arrives.",
      fix: 'Give the component that reports status or results a11y.live: "polite".',
    });
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;
  const infos = findings.filter((f) => f.severity === "info").length;

  return { findings, errors, warnings, infos, pass: errors === 0 };
}
