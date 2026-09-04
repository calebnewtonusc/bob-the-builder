/**
 * Generate the HUD's component reference from the catalog.
 *
 * The vocabulary was written by hand in two files, which is the exact failure
 * this repo's operating manual warns about: a hand-written prompt drifts from
 * the catalog the first time somebody adds a component, and the failure is
 * silent because the renderer drops what it does not recognise.
 *
 * So the reference is generated between markers, and `--check` fails when the
 * files have fallen behind. Everything outside the markers stays hand-written,
 * because the parts that are worth writing by hand are the judgement calls
 * about *when* to draw something, and those do not belong in a schema.
 *
 *   npx tsx scripts/gen-hud-docs.ts          rewrite
 *   npx tsx scripts/gen-hud-docs.ts --check  fail if stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hudCatalog } from "../src/hud/catalog.js";

const BEGIN = "<!-- generated: components -->";
const END = "<!-- /generated -->";

const TARGETS = [
  join(import.meta.dirname, "..", "hud", "CLAUDE.md"),
  join(
    import.meta.dirname, "..", "..", "chewbacca", "skills", "hud", "SKILL.md",
  ),
];

/**
 * Grouped for reading, not alphabetically.
 *
 * A model picking a component is choosing between near neighbours, so the
 * neighbours have to be adjacent. An alphabetical list puts `Bars` next to
 * `Button`, which are not alternatives to each other in any situation.
 */
const GROUPS: Array<{ title: string; names: string[] }> = [
  { title: "Structure", names: ["Screen", "Stack"] },
  { title: "Prose", names: ["Heading", "Text", "List"] },
  { title: "Data", names: ["Metric", "Table", "Status"] },
  { title: "Dashboard", names: ["Sparkline", "Bars", "Ring", "Events"] },
  { title: "Anything else", names: ["Diagram", "File"] },
  { title: "Controls", names: ["Button", "Field", "Select", "Checkbox"] },
];

function render(): string {
  const out: string[] = [BEGIN, ""];
  const components = hudCatalog.components as Record<
    string,
    { describe: string; examples?: string[] }
  >;

  const seen = new Set<string>();
  for (const group of GROUPS) {
    const present = group.names.filter((name) => name in components);
    if (present.length === 0) continue;
    out.push(`### ${group.title}`, "");
    for (const name of present) {
      seen.add(name);
      const def = components[name]!;
      out.push(`- **${name}** ${def.describe}`);
      for (const example of def.examples ?? []) {
        out.push("", "  ```", `  ${example}`, "  ```");
      }
      out.push("");
    }
  }

  // Anything the groups forgot still has to appear, or adding a component and
  // not updating this file would silently hide it, which is the failure this
  // script exists to prevent.
  const ungrouped = Object.keys(components).filter((name) => !seen.has(name));
  if (ungrouped.length > 0) {
    out.push("### Ungrouped", "");
    for (const name of ungrouped) {
      out.push(`- **${name}** ${components[name]!.describe}`, "");
    }
  }

  out.push(END);
  return out.join("\n");
}

function main(): number {
  const block = render();
  const check = process.argv.includes("--check");
  let stale = 0;

  for (const path of TARGETS) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      console.error(`missing: ${path}`);
      stale += 1;
      continue;
    }

    const begin = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    if (begin === -1 || end === -1) {
      console.error(
        `${path} has no generated block. Add these two lines where the ` +
          `component reference should go:\n  ${BEGIN}\n  ${END}`,
      );
      stale += 1;
      continue;
    }

    const next = text.slice(0, begin) + block + text.slice(end + END.length);
    if (next === text) continue;

    if (check) {
      console.error(`stale: ${path}`);
      stale += 1;
    } else {
      writeFileSync(path, next);
      console.log(`wrote: ${path}`);
    }
  }

  if (check && stale > 0) {
    console.error(
      `\n${stale} file(s) behind the catalog. Run: npx tsx scripts/gen-hud-docs.ts`,
    );
    return 1;
  }
  if (!check) {
    console.log(
      `${Object.keys(hudCatalog.components).length} components documented`,
    );
  }
  return 0;
}

process.exit(main());
