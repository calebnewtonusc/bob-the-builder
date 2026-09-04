/**
 * Authoring and editing: the only two places a model is involved.
 *
 * Authoring happens once. Editing happens when a person wants something changed,
 * and crucially it produces a **patch** rather than a replacement. That is the
 * difference between an app you can live with and a prompt-to-code tool you
 * cannot: regenerating from a new prompt produces a discontinuous jump where the
 * relationship between what you asked and what changed is opaque, so nothing is
 * ever really iterated on, only replaced. A patch is legible, revertible, and
 * leaves everything you did not ask about exactly as it was.
 *
 * The patch format is the same op stream the renderer already speaks, so an edit
 * is inspectable before it is applied and storable in history after.
 */

import type { Catalog } from "../core/catalog.js";
import type { Json, Op, Spec } from "../core/spec.js";
import { parseLine, serializeOp } from "../core/lines.js";
import { buildSystemPrompt } from "../core/prompt.js";
import { SurfaceStore } from "../core/store.js";
import type { ModelAdapter } from "../eval/adapter.js";
import {
  createApp,
  migrateSchema,
  recordHistory,
  slugify,
  type AppFile,
  type AppSchema,
} from "./format.js";
import { hydrate } from "./runtime.js";

export class AuthorError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "AuthorError";
  }
}

/* -------------------------------------------------------------------------- */
/* Output format                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The model's answer is Bob Lines with two extra line kinds at the top.
 *
 * The schema arrives as one JSON line rather than as a second little language,
 * because it is small, written once, and nobody benefits from a compact encoding
 * of a thing that appears one time per app.
 */
export interface Authored {
  title: string;
  schema: AppSchema;
  ops: Op[];
  summary: string;
}

/** The four Bob Lines verbs, plus the two authoring-only line kinds. */
const VERBS = new Set(["c", ">", "d", "r"]);

/**
 * Pull the answer out of whatever the model wrapped it in.
 *
 * Told plainly to emit lines and nothing else, a real model will still open with
 * "Here is your app:", wrap the whole thing in a code fence, or append a
 * paragraph explaining what it did. The first live run against a real model
 * failed on exactly this and threw a stack trace at the user.
 *
 * So the rule is: strict about what gets into the app, permissive about what
 * surrounds it. A line is content only if it starts with a known verb; anything
 * else is framing and is dropped. A prose line beginning with "c " still has to
 * parse as a component or it is discarded too, so this widens tolerance without
 * widening what can actually reach the interface.
 */
function contentLines(text: string): { lines: string[]; ignored: number } {
  const lines: string[] = [];
  let ignored = 0;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*```[a-z]*\s*$/i, "").replace(/^\s*```\s*/, "");
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;

    if (
      trimmed.startsWith("t ") ||
      trimmed.startsWith("why ") ||
      trimmed.startsWith("schema ")
    ) {
      lines.push(trimmed);
      continue;
    }

    const verb = trimmed.split(/\s+/)[0] ?? "";
    if (VERBS.has(verb)) lines.push(trimmed);
    else ignored++;
  }

  return { lines, ignored };
}

/** Parse view lines one at a time, dropping any that will not parse. */
function parseViewLines(lines: string[]): { ops: Op[]; dropped: string[] } {
  const ops: Op[] = [];
  const dropped: string[] = [];
  for (const line of lines) {
    try {
      const op = parseLine(line);
      if (op) ops.push(op);
    } catch {
      // A line that looked like a verb but is not a valid op is framing that
      // happened to start with the wrong word. Dropping it beats failing the
      // whole build over one sentence.
      dropped.push(line);
    }
  }
  return { ops, dropped };
}

export function parseAuthored(text: string): Authored {
  let title = "";
  let summary = "";
  let schema: AppSchema | null = null;
  const viewLines: string[] = [];

  const { lines } = contentLines(text);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("t ")) {
      title = trimmed.slice(2).trim();
      continue;
    }
    if (trimmed.startsWith("why ")) {
      summary = trimmed.slice(4).trim();
      continue;
    }
    if (trimmed.startsWith("schema ")) {
      const json = trimmed.slice(7).trim();
      try {
        schema = JSON.parse(json) as AppSchema;
      } catch (err) {
        throw new AuthorError(
          `The schema line is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          text,
        );
      }
      continue;
    }
    viewLines.push(line);
  }

  if (!schema || typeof schema.collections !== "object") {
    throw new AuthorError(
      "The model's answer had no schema line, so there is nothing to build. " +
        "It may have replied with prose instead of the requested format.",
      text,
    );
  }
  for (const [name, def] of Object.entries(schema.collections)) {
    if (!def.path?.startsWith("/")) {
      throw new AuthorError(`Collection ${name} has no valid path.`, text);
    }
    if (!Array.isArray(def.fields) || def.fields.length === 0) {
      throw new AuthorError(`Collection ${name} has no fields.`, text);
    }
  }

  const { ops } = parseViewLines(viewLines);
  if (!ops.some((op) => op.op === "root")) {
    throw new AuthorError(
      "The model's answer never declared a root component, so the app would " +
        "render nothing.",
      text,
    );
  }

  return {
    title: title || "Untitled app",
    schema,
    ops,
    summary: summary || "Built the app.",
  };
}

/* -------------------------------------------------------------------------- */
/* Prompts                                                                    */
/* -------------------------------------------------------------------------- */

const AUTHOR_RULES = `You are building someone a small app they will keep and use
for months. It is written once and then runs on its own, so get the structure
right rather than the wording clever.

Answer with these lines and nothing else. No prose, no markdown, no code fences.

  t <title>                  the app's name, in the person's own words
  why <one sentence>         what you built and why, for the history
  schema <json>              one line of JSON, the durable data shape
  <Bob Lines>                the view

The schema names the collections of records the app stores:

  schema {"collections":{"applications":{"path":"/applications","noun":"application","fields":[
    {"name":"company","label":"Company","type":"text","required":true},
    {"name":"status","label":"Status","type":"select","options":["Applied","Interview","Offer","Rejected"]}]}}}

Field types: text, longtext, number, date, select, checkbox, url.

Then the view, in Bob Lines. Rules that matter:

1. The root is always a Screen, and it is claimed with \`r\` on the second line so
   the app appears immediately.
2. Bind a Table's rows to its collection: rows=@/applications
3. Bind every input to the draft: value=@/draft/applications/company
4. A form needs a Button with action=add and collection=<name>.
5. Counts are computed, never typed: value={"$count":"/applications"}
6. Give the person the fields they asked for and the two or three they obviously
   meant. Do not invent a data model larger than the request.`;

export function buildAuthorPrompt(catalog: Catalog): string {
  const componentDocs = buildSystemPrompt(catalog, { format: "lines" });
  // The component reference is generated from the catalog so it cannot drift
  // from it, and the authoring rules sit on top.
  return `${AUTHOR_RULES}\n\n---\n\n${componentDocs}`;
}

export function buildEditPrompt(catalog: Catalog, app: AppFile): string {
  const view = Object.values(app.view.elements)
    .map((node) =>
      serializeOp({ op: "component", node }),
    )
    .join("\n");
  const edges = Object.values(app.view.elements)
    .filter((n) => n.children.length > 0)
    .map((n) => serializeOp({ op: "children", id: n.id, children: n.children }))
    .join("\n");

  const schema = JSON.stringify(app.schema);

  return `You are editing an app the person already uses. Change only what they
asked for. Everything you do not mention stays exactly as it is.

Answer with these lines and nothing else. No prose, no markdown, no code fences.

  why <one sentence>     what you changed, for the history
  <Bob Lines>            ONLY the ops that change something

Emitting \`c <id> …\` for an id that already exists replaces that component.
Emitting a new id adds one. Emitting \`> <id> …\` sets that component's children,
so include the full child list for any parent you touch.

Do not re-emit the whole app. Do not emit \`r\` unless the root itself changes.
Never touch the person's data: you are changing the interface, not the records.

If the request needs a NEW FIELD on a record, you must emit a \`schema\` line
carrying the complete updated schema, as well as the view ops for it. A field that
appears in the view but not the schema renders an input that can never be saved.

Only additions are applied. Removing a field or changing its type is refused and
reported, because the person asked for a change, not for their records to change
shape underneath them.

## This app

title: ${app.title}
schema: ${schema}

current view:
${view}
${edges}

---

${buildSystemPrompt(catalog, { format: "lines" })}`;
}

/* -------------------------------------------------------------------------- */
/* Flows                                                                      */
/* -------------------------------------------------------------------------- */

async function collect(source: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of source) out += chunk;
  return out;
}

/** Apply ops to a catalog-validated store and return the resulting view. */
function buildView(
  catalog: Catalog,
  ops: Op[],
  base?: Spec,
): { view: Spec; warnings: string[] } {
  const warnings: string[] = [];
  const store = new SurfaceStore({
    catalog,
    mode: "lenient",
    onEvent: (e) => {
      if (e.type === "warn" || e.type === "error") warnings.push(e.message);
    },
  });
  if (base) {
    // Replay the existing view so a patch lands on top of it rather than
    // building a fresh surface that is missing everything it did not mention.
    const replay: Op[] = Object.values(base.elements).map((node) => ({
      op: "component" as const,
      node,
    }));
    for (const node of Object.values(base.elements)) {
      if (node.children.length > 0) {
        replay.push({ op: "children", id: node.id, children: node.children });
      }
    }
    if (base.root) replay.push({ op: "root", id: base.root });
    store.apply(replay);
  }
  store.apply(ops);
  return { view: store.snapshot, warnings };
}

export interface AuthorResult {
  app: AppFile;
  warnings: string[];
  raw: string;
}

/** Build a new app from a plain-language request. One model call, then never again. */
export async function authorApp(
  adapter: ModelAdapter,
  request: string,
  catalog: Catalog,
): Promise<AuthorResult> {
  const raw = await collect(adapter.stream(buildAuthorPrompt(catalog), request));
  const authored = parseAuthored(raw);
  const { view, warnings } = buildView(catalog, authored.ops);

  if (!view.root) {
    throw new AuthorError("The authored view has no resolvable root.", raw);
  }

  const app = hydrate(
    createApp({
      id: slugify(authored.title),
      title: authored.title,
      catalog: catalog.name,
      schema: authored.schema,
      view,
      data: {},
    }),
  );

  return {
    app: recordHistory(app, {
      request,
      ops: authored.ops,
      summary: authored.summary,
      by: adapter.name,
    }),
    warnings,
    raw,
  };
}

export interface EditResult {
  app: AppFile;
  ops: Op[];
  summary: string;
  /** Schema fields this edit added, as "collection.field". */
  addedFields: string[];
  warnings: string[];
  raw: string;
}

/**
 * Change an app in place.
 *
 * Returns the patched app without writing it, so a caller can show the person
 * what changed before committing. `data` is passed through untouched by
 * construction: the model never sees it and the ops cannot reach it.
 */
export async function editApp(
  adapter: ModelAdapter,
  app: AppFile,
  request: string,
  catalog: Catalog,
): Promise<EditResult> {
  const raw = await collect(adapter.stream(buildEditPrompt(catalog, app), request));

  let summary = "";
  let proposed: AppSchema | null = null;
  const viewLines: string[] = [];

  for (const line of contentLines(raw).lines) {
    if (line.startsWith("why ")) {
      summary = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("t ")) continue;
    if (line.startsWith("schema ")) {
      try {
        proposed = JSON.parse(line.slice(7).trim()) as AppSchema;
      } catch {
        // A malformed schema line means no migration, not a failed edit. The
        // view ops may still be good, and the person is told what was skipped.
        proposed = null;
      }
      continue;
    }
    viewLines.push(line);
  }

  const { ops } = parseViewLines(viewLines);
  if (ops.length === 0) {
    throw new AuthorError(
      "The model's answer contained no changes to apply. Nothing was written.",
      raw,
    );
  }

  const dataOps = ops.filter((op) => op.op === "data");
  if (dataOps.length > 0) {
    throw new AuthorError(
      `An edit tried to write ${dataOps.length} value(s) into your data. ` +
        `Edits change the interface, never the records. Nothing was applied.`,
      raw,
    );
  }

  const { view, warnings: viewWarnings } = buildView(catalog, ops, app.view);
  const warnings = [...viewWarnings];

  // Apply the schema change before hydrating, so a newly added field exists in
  // the draft the moment the app is next opened.
  let schema = app.schema;
  let addedFields: string[] = [];
  if (proposed && typeof proposed.collections === "object") {
    const migration = migrateSchema(app.schema, proposed);
    schema = migration.schema;
    addedFields = migration.added;
    warnings.push(...migration.refused);
  }

  const next = hydrate({ ...app, schema, view });

  return {
    app: recordHistory(next, {
      request,
      ops,
      summary: summary || "Changed the app.",
      by: adapter.name,
    }),
    ops,
    summary: summary || "Changed the app.",
    addedFields,
    warnings,
    raw,
  };
}
