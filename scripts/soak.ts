/**
 * Soak test the author prompt against many varied requests.
 *
 * A prompt that works on the three examples its author had in mind is not
 * tested. This runs a real model over a corpus of requests people would actually
 * type, including several that do not map to a list of records at all, and
 * reports what fraction produced an app that is genuinely usable rather than one
 * that merely parsed.
 *
 * Usage:
 *   BOB_MODEL_CMD='claude -p' npx tsx scripts/soak.ts [--limit N] [--concurrency N]
 *
 * Output is a table of failures and a summary. Nothing is written to a real
 * workspace: every request gets a throwaway directory.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appCatalog } from "../src/app/catalog.js";
import { authorApp } from "../src/app/author.js";
import { hydrate, applyAction, draftPath } from "../src/app/runtime.js";
import { renderApp } from "../src/app/render-text.js";
import { exportHtml } from "../src/app/export-html.js";
import { resolveAdapter } from "../src/app/cli-commands.js";
import type { AppFile } from "../src/app/format.js";

/**
 * The corpus.
 *
 * Weighted toward what people actually build for themselves, with a deliberate
 * tail of requests that do not fit: the interesting question is not whether a
 * tracker works, it is what happens to "a calculator" or "help me stay
 * organised".
 */
const REQUESTS: string[] = [
  // Straightforward trackers
  "a tracker for my job applications",
  "a log of my workouts with the exercise, weight and reps",
  "a tracker for the books I read with my rating",
  "somewhere to track the plants I own and when I watered them",
  "a habit tracker for my morning routine",
  "track my mood every day",
  "a log of my running mileage",
  "keep track of the podcasts I want to listen to",
  "a tracker for job interviews and how they went",
  "somewhere to log my guitar practice",

  // Money and admin
  "track my expenses by category",
  "a log of invoices I have sent and whether they were paid",
  "keep track of subscriptions I pay for monthly",
  "somewhere to record my mileage for tax",
  "a tracker for bills and when they are due",

  // Lists rather than logs
  "a grocery list",
  "gift ideas for people",
  "a packing list for trips",
  "my bucket list",
  "books I want to read next",
  "a list of restaurants I want to try",

  // Study and work
  "track my assignments and their due dates",
  "a log of the papers I have read with notes",
  "somewhere to track applications to grad school",
  "keep track of my class attendance",
  "a tracker for the clubs I applied to and their status",

  // Health
  "a log of my medication doses",
  "track my sleep each night",
  "somewhere to record symptoms and when they happen",
  "a log of physical therapy exercises I completed",

  // Relationships and life
  "keep track of people I owe a reply to",
  "a log of who I prayed for and when",
  "track the movies I watch with a rating",
  "somewhere to note down conversations with my mentor",

  // Vague or underspecified
  "something to help me stay organised",
  "todo",
  "a list",
  "help me keep track of stuff for school",

  // Deliberately outside the domain
  "a calculator",
  "a timer for my workouts",
  "a game of tic tac toe",
  "a poem about the sea",

  // Multi-entity, which the format only partly supports
  "my clients and the invoices for each one",
  "recipes and the ingredients they need",

  // Other languages
  "un registro de los libros que leo",
  "일기장",
];

interface Outcome {
  request: string;
  ok: boolean;
  /** Why it failed, or what is suspicious about a success. */
  problems: string[];
  title?: string;
  components?: number;
  fields?: number;
  ms: number;
}

/**
 * Judge an authored app the way a person would within ten seconds of opening it.
 *
 * Parsing is not the bar. An app that renders an empty screen, or a form with no
 * way to save, or a table of a collection that does not exist, technically
 * succeeded and is useless.
 */
function inspect(app: AppFile): string[] {
  const problems: string[] = [];
  const elements = Object.values(app.view.elements);
  const types = new Set(elements.map((e) => e.type));
  const collections = Object.entries(app.schema.collections);

  if (elements.length < 3) problems.push("almost nothing on screen");
  if (collections.length === 0) problems.push("no collections in the schema");

  const [name, def] = collections[0] ?? [];
  if (def && def.fields.length === 0) problems.push("collection has no fields");

  // A form with no save button, or a save button with no form, is the most
  // common way for a generated app to be technically valid and unusable.
  const hasInput = types.has("Field") || types.has("Select") || types.has("Checkbox");
  const addButtons = elements.filter(
    (e) => e.type === "Button" && e.props["action"] === "add",
  );
  if (hasInput && addButtons.length === 0) problems.push("inputs but no way to save");
  if (addButtons.length > 0 && !hasInput) problems.push("a save button but nothing to fill in");

  // Every input must be bound to the draft, or typing goes nowhere.
  for (const el of elements) {
    if (!["Field", "Select", "Checkbox"].includes(el.type)) continue;
    const bind = el.props["value"];
    const path =
      typeof bind === "object" && bind !== null && "$bind" in bind
        ? String((bind as { $bind: string }).$bind)
        : null;
    if (!path) {
      problems.push(`${el.type} "${String(el.props["label"] ?? el.id)}" is not bound`);
      continue;
    }
    if (!path.startsWith("/draft/")) {
      problems.push(`${el.type} bound to ${path} rather than a draft`);
      continue;
    }
    const field = path.split("/").pop() ?? "";
    if (def && !def.fields.some((f) => f.name === field)) {
      problems.push(`input bound to "${field}", which is not in the schema`);
    }
  }

  // A table must point at a collection that exists.
  for (const el of elements) {
    if (el.type !== "Table") continue;
    const rows = el.props["rows"];
    const path =
      typeof rows === "object" && rows !== null && "$bind" in rows
        ? String((rows as { $bind: string }).$bind)
        : null;
    if (!path) problems.push("table rows are not bound to a collection");
    else if (!collections.some(([, d]) => d.path === path)) {
      problems.push(`table bound to ${path}, which no collection provides`);
    }
    const cols = el.props["columns"];
    if (Array.isArray(cols) && def) {
      for (const col of cols as { field: string }[]) {
        if (!def.fields.some((f) => f.name === col.field)) {
          problems.push(`column "${col.field}" is not a field on the record`);
        }
      }
    }
  }

  // The root must be a Screen, since that is what every renderer expects.
  const root = app.view.root ? app.view.elements[app.view.root] : undefined;
  if (root && root.type !== "Screen") problems.push(`root is ${root.type}, not Screen`);

  // And the whole thing must actually run: add a record and render it.
  if (name && def) {
    try {
      let live = hydrate(app);
      for (const field of def.fields) {
        live = applyAction(live, {
          type: "set",
          path: `${draftPath(name)}/${field.name}`,
          // A select field has to be filled with one of its own options.
          //
          // The first version filled every text-ish field with "test", which a
          // select rejects by design, so seven of twelve runs failed validation
          // and the harness reported 42% usable. It was measuring itself. Any
          // soak that fills inputs has to fill them the way a person would or
          // its number means nothing.
          value:
            field.type === "number"
              ? 1
              : field.type === "checkbox"
                ? true
                : field.options?.length
                  ? field.options[0]
                  : "test",
        }).app;
      }
      const added = applyAction(live, { type: "add", collection: name });
      if (!added.changed) problems.push(`cannot add a record: ${added.message}`);
      else {
        renderApp(added.app, { plain: true });
        exportHtml(added.app);
      }
    } catch (err) {
      problems.push(`crashes when used: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return problems;
}

async function run(request: string): Promise<Outcome> {
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "bob-soak-"));
  try {
    const adapter = await resolveAdapter();
    const { app } = await authorApp(adapter, request, appCatalog);
    const problems = inspect(app);
    return {
      request,
      ok: problems.length === 0,
      problems,
      title: app.title,
      components: Object.keys(app.view.elements).length,
      fields: Object.values(app.schema.collections)[0]?.fields.length ?? 0,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      request,
      ok: false,
      problems: [`failed to build: ${err instanceof Error ? err.message : String(err)}`],
      ms: Date.now() - started,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run with bounded concurrency, because a model will rate limit otherwise. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: number): number => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : Number(args[i + 1]);
  };

  const limit = flag("limit", REQUESTS.length);
  const concurrency = flag("concurrency", 6);
  const corpus = REQUESTS.slice(0, limit);

  console.log(`Soaking the author prompt over ${corpus.length} requests, ${concurrency} at a time.\n`);

  let done = 0;
  const results = await pool(corpus, concurrency, async (request) => {
    const outcome = await run(request);
    done++;
    process.stderr.write(
      `\r  ${done}/${corpus.length}  ${outcome.ok ? "ok" : "FAIL"}  ${request.slice(0, 44).padEnd(46)}`,
    );
    return outcome;
  });
  process.stderr.write("\r" + " ".repeat(70) + "\r");

  const failed = results.filter((r) => !r.ok);

  for (const r of failed) {
    console.log(`\n  ✗ ${r.request}`);
    if (r.title) console.log(`    built "${r.title}" (${r.components} components, ${r.fields} fields)`);
    for (const p of r.problems) console.log(`    · ${p}`);
  }

  const rate = ((results.length - failed.length) / results.length) * 100;
  const median = results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? 0;

  console.log(
    `\n\n  ${results.length - failed.length}/${results.length} usable ` +
      `(${rate.toFixed(0)}%), median ${(median / 1000).toFixed(1)}s\n`,
  );

  // Group the failures, because ten instances of one cause is one fix.
  const causes = new Map<string, number>();
  for (const r of failed) {
    for (const p of r.problems) {
      const key = p.replace(/"[^"]*"/g, '"…"').replace(/\/[\w/]+/g, "/…");
      causes.set(key, (causes.get(key) ?? 0) + 1);
    }
  }
  if (causes.size > 0) {
    console.log("  Grouped causes:");
    for (const [cause, n] of [...causes.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(3)} × ${cause}`);
    }
    console.log("");
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
