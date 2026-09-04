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
import { parseLines, serializeOp } from "../core/lines.js";
import { buildSystemPrompt } from "../core/prompt.js";
import { SurfaceStore } from "../core/store.js";
import type { ModelAdapter } from "../eval/adapter.js";
import {
  createApp,
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

export function parseAuthored(text: string): Authored {
  let title = "";
  let summary = "";
  let schema: AppSchema | null = null;
  const viewLines: string[] = [];

  for (const line of text.split("\n")) {
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
    throw new AuthorError("No schema line. An app needs a schema.", text);
  }
  for (const [name, def] of Object.entries(schema.collections)) {
    if (!def.path?.startsWith("/")) {
      throw new AuthorError(`Collection ${name} has no valid path.`, text);
    }
    if (!Array.isArray(def.fields) || def.fields.length === 0) {
      throw new AuthorError(`Collection ${name} has no fields.`, text);
    }
  }

  const ops = parseLines(viewLines.join("\n"));
  if (!ops.some((op) => op.op === "root")) {
    throw new AuthorError("The view never declares a root, so it would render nothing.", text);
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

If the request needs a new field on a record, say so in \`why\` and emit the view
ops for it. A human will handle the schema change.

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
  const viewLines: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("why ")) {
      summary = trimmed.slice(4).trim();
      continue;
    }
    viewLines.push(line);
  }

  const ops = parseLines(viewLines.join("\n"));
  if (ops.length === 0) {
    throw new AuthorError("The edit produced no changes.", raw);
  }

  const dataOps = ops.filter((op) => op.op === "data");
  if (dataOps.length > 0) {
    throw new AuthorError(
      `An edit tried to write ${dataOps.length} value(s) into your data. ` +
        `Edits change the interface, never the records. Nothing was applied.`,
      raw,
    );
  }

  const { view, warnings } = buildView(catalog, ops, app.view);

  return {
    app: recordHistory({ ...app, view }, {
      request,
      ops,
      summary: summary || "Changed the app.",
      by: adapter.name,
    }),
    ops,
    summary: summary || "Changed the app.",
    warnings,
    raw,
  };
}
