/**
 * The catalog and the renderer live in different languages, and nothing forces
 * them to agree.
 *
 * That is the sharpest drift risk in this project. The Swift renderer drops any
 * component it does not recognise, silently, so a component documented here but
 * never implemented there produces a panel with a hole in it and no error
 * anywhere. Nobody finds that by reading either file, because each one is
 * internally consistent.
 *
 * These tests read the Swift source and check it against the catalog.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hudCatalog } from "../src/hud/catalog.js";

const RENDERER = readFileSync(
  join(import.meta.dirname, "..", "hud", "Sources", "BobHUDKit", "SurfaceView.swift"),
  "utf8",
);

const names = Object.keys(hudCatalog.components);

describe("the HUD catalog and the Swift renderer", () => {
  it("documents at least the components worth having", () => {
    expect(names.length).toBeGreaterThanOrEqual(18);
  });

  it.each(names)("the renderer knows how to draw %s", (name) => {
    // Every component reaches the renderer through a `case "Name"` in the
    // dispatch switch. A component missing from it is dropped without a word.
    expect(RENDERER).toContain(`"${name}"`);
  });

  it("has no component the renderer cannot draw", () => {
    const missing = names.filter((name) => !RENDERER.includes(`"${name}"`));
    expect(missing).toEqual([]);
  });

  it("gives every component a describe that says when to pick it", () => {
    for (const [name, def] of Object.entries(hudCatalog.components)) {
      // The describe is what a model chooses by. One that only names the
      // component teaches nothing a model did not already have from the name.
      expect(def.describe.length, `${name} describe is too short`).toBeGreaterThan(40);
      expect(def.describe, `${name} describe should not start with its own name`)
        .not.toMatch(new RegExp(`^${name}\\b`, "i"));
    }
  });

  it("gives every component at least one real example", () => {
    for (const [name, def] of Object.entries(hudCatalog.components)) {
      const examples = def.examples ?? [];
      expect(examples.length, `${name} has no example`).toBeGreaterThan(0);
      for (const example of examples) {
        // Examples go straight into the prompt, so a broken one teaches the
        // model to emit a broken line.
        expect(example, `${name} example is not an op`).toMatch(/^c \w+ [A-Z]/);
        // Word boundaries, or the component named `Bars` fails a check for
        // the placeholder word `bar`. A test that cries wolf gets deleted.
        expect(example, `${name} example uses placeholder content`)
          .not.toMatch(/\b(lorem|ipsum|foo|bar|baz|qux)\b|Item 1/i);
        // TODO is only a placeholder when it is shouted. "Todo" is a perfectly
        // real value for a status field, and the Select example uses it as one.
        expect(example, `${name} example has a TODO in it`)
          .not.toMatch(/\bTODO\b/);
      }
    }
  });

  it("keeps arrays in examples free of spaces the parser would split on", () => {
    for (const [name, def] of Object.entries(hudCatalog.components)) {
      for (const example of def.examples ?? []) {
        const arrays = example.match(/=\[[^\]]*\]/g) ?? [];
        for (const array of arrays) {
          // The line parser splits on whitespace before it parses JSON, so a
          // space inside an array literal truncates the value silently.
          expect(array, `${name} example has a space inside an array`)
            .not.toMatch(/,\s/);
        }
      }
    }
  });
});
