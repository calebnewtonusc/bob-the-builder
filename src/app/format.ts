/**
 * An app file.
 *
 * This is the whole thesis in one data structure, so it is worth being precise
 * about what is different here.
 *
 * Every generative UI system, including the streaming half of this repo, puts
 * the model in the request path. You ask, it generates, you look, it is thrown
 * away. Ask again tomorrow and you get a different interface, which is why the
 * muscle-memory objection to generative UI has never had an answer: you cannot
 * become familiar with something that does not persist.
 *
 * Here the model is the **author**, not the runtime. It writes this file once.
 * After that the file is the app: opening it costs no tokens, takes no network,
 * and produces a byte-identical interface every time. The model is only invoked
 * again when you want to *change* something, and then it emits a patch rather
 * than a replacement.
 *
 * That last part matters more than it sounds. Regenerating an app from a new
 * prompt produces a discontinuous jump: the CHI 2025 Jelly paper names this as
 * the reason prompt-to-code tools cannot be iterated on, because the
 * relationship between what you asked and what changed is opaque. A patch is
 * legible, diffable, and revertible, and the patch format is the same op stream
 * the renderer already speaks.
 *
 * The file holds three things that are deliberately separate:
 *
 *   schema   what a record looks like. The durable part. Changing it is a
 *            migration, and the app says so.
 *   view     the interface, bound to the data by JSON Pointer. Cheap to change.
 *   data     yours. Never touched by an edit to the view.
 *
 * Keeping data out of the view is what lets you restyle an app without losing a
 * year of records, and lets you fix a typo in a label without a model seeing
 * your data at all.
 */

import type { Json, Op, Spec } from "../core/spec.js";

export const APP_FORMAT_VERSION = 1;

/** A field on a record. Deliberately small: these map to real form controls. */
export interface FieldDef {
  name: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "checkbox" | "url" | "longtext";
  /** Options for `select`. Ignored otherwise. */
  options?: string[];
  required?: boolean;
}

/** A named collection of records. Most apps have exactly one. */
export interface CollectionDef {
  /** Pointer to the array in `data`, e.g. `/applications`. */
  path: string;
  /** Singular noun, used in generated labels: "application". */
  noun: string;
  fields: FieldDef[];
}

export interface AppSchema {
  collections: Record<string, CollectionDef>;
}

export interface HistoryEntry {
  at: string;
  /** What the person asked for, verbatim. */
  request: string;
  /** Ops applied to the view. Empty for a data-only or schema change. */
  ops: Op[];
  /** Human summary, written by the author model. */
  summary: string;
  /** Model that made the change, or "runtime" for a deterministic edit. */
  by: string;
}

export interface AppFile {
  version: number;
  id: string;
  title: string;
  /** Name of the catalog this view was built against. */
  catalog: string;
  createdAt: string;
  updatedAt: string;
  schema: AppSchema;
  view: Spec;
  data: Record<string, Json>;
  history: HistoryEntry[];
}

export class AppFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppFormatError";
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidAppId(id: string): boolean {
  return ID_RE.test(id);
}

/** Turn a title into a stable, filesystem-safe id. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "app";
}

export function createApp(init: {
  id: string;
  title: string;
  catalog: string;
  schema: AppSchema;
  view: Spec;
  data?: Record<string, Json>;
}): AppFile {
  const now = new Date().toISOString();
  return {
    version: APP_FORMAT_VERSION,
    id: init.id,
    title: init.title,
    catalog: init.catalog,
    createdAt: now,
    updatedAt: now,
    schema: init.schema,
    view: init.view,
    data: init.data ?? {},
    history: [],
  };
}

/**
 * Validate a file read off disk.
 *
 * Strict, because an app file is a durable artifact a person may have been using
 * for months. Silently accepting a malformed one and rendering a partial
 * interface is much worse than refusing to open it and saying why.
 */
export function parseApp(raw: unknown): AppFile {
  if (typeof raw !== "object" || raw === null) {
    throw new AppFormatError("App file is not an object.");
  }
  const app = raw as Partial<AppFile>;

  if (typeof app.version !== "number") {
    throw new AppFormatError("App file has no version.");
  }
  if (app.version > APP_FORMAT_VERSION) {
    throw new AppFormatError(
      `App file is version ${app.version}, but this build understands up to ` +
        `${APP_FORMAT_VERSION}. Upgrade bobthebuilder to open it.`,
    );
  }
  if (typeof app.id !== "string" || !isValidAppId(app.id)) {
    throw new AppFormatError(`App file has an invalid id: ${String(app.id)}`);
  }
  if (typeof app.title !== "string" || !app.title.trim()) {
    throw new AppFormatError("App file has no title.");
  }
  if (typeof app.view !== "object" || app.view === null) {
    throw new AppFormatError("App file has no view.");
  }
  if (!app.view.root) {
    throw new AppFormatError(
      "App view has no root, so it would render nothing. The file is corrupt.",
    );
  }
  if (typeof app.schema !== "object" || app.schema === null) {
    throw new AppFormatError("App file has no schema.");
  }

  return {
    version: app.version,
    id: app.id,
    title: app.title,
    catalog: app.catalog ?? "personal",
    createdAt: app.createdAt ?? new Date().toISOString(),
    updatedAt: app.updatedAt ?? new Date().toISOString(),
    schema: { collections: app.schema.collections ?? {} },
    view: {
      root: app.view.root,
      elements: app.view.elements ?? {},
      data: app.view.data ?? {},
    },
    data: app.data ?? {},
    history: Array.isArray(app.history) ? app.history : [],
  };
}

export function serializeApp(app: AppFile): string {
  return JSON.stringify(app, null, 2) + "\n";
}

/** Record an edit. History is append-only, so an app can always be explained. */
export function recordHistory(app: AppFile, entry: Omit<HistoryEntry, "at">): AppFile {
  return {
    ...app,
    updatedAt: new Date().toISOString(),
    history: [...app.history, { at: new Date().toISOString(), ...entry }],
  };
}

/**
 * Restore the view to how it looked before the last N edits.
 *
 * Possible only because edits are stored as ops rather than as replacements:
 * replaying history from the start up to a point rebuilds any prior view exactly.
 * Data is untouched, which is the behaviour a person wants when they say "undo
 * that change" about a layout.
 */
export function viewAtRevision(app: AppFile, revision: number): Op[] {
  const upTo = Math.max(0, Math.min(revision, app.history.length));
  const ops = app.history.slice(0, upTo).flatMap((h) => h.ops);

  // Replay only reconstructs a view if the app's creation is in its history,
  // which is true of anything `authorApp` built and false of an app assembled by
  // hand. Silently returning an empty op list would produce a blank view that
  // looks like a successful revert, so this fails loudly instead.
  if (upTo > 0 && !ops.some((op) => op.op === "root")) {
    throw new AppFormatError(
      `Cannot rebuild revision ${revision} of ${app.id}: its history does not ` +
        `include the app's creation, so there is nothing to replay onto.`,
    );
  }
  return ops;
}

/* -------------------------------------------------------------------------- */
/* Schema migration                                                           */
/* -------------------------------------------------------------------------- */

export interface Migration {
  schema: AppSchema;
  /** Fields added, as "collection.field". */
  added: string[];
  /** Changes refused, with why. */
  refused: string[];
}

/**
 * Merge a proposed schema into the current one, additively only.
 *
 * Adding a field cannot lose anything: existing records simply do not have it,
 * and `hydrate` fills the draft. Removing or retyping one can, and a person
 * asking for a notes column has not asked to lose their ratings. So additions
 * are applied and everything else is refused and reported.
 *
 * This exists because an edit that adds a field to the *view* without adding it
 * to the schema produces an app that looks correct and is broken: the input
 * renders, and nothing can ever be saved into it. A real model did exactly that
 * on the first live run.
 */
export function migrateSchema(current: AppSchema, proposed: AppSchema): Migration {
  const collections: Record<string, CollectionDef> = {};
  const added: string[] = [];
  const refused: string[] = [];

  for (const [name, def] of Object.entries(current.collections)) {
    const next = proposed.collections[name];
    if (!next) {
      collections[name] = def;
      continue;
    }

    const byName = new Map(def.fields.map((f) => [f.name, f]));
    const fields = [...def.fields];

    for (const field of next.fields ?? []) {
      const existing = byName.get(field.name);
      if (!existing) {
        fields.push(field);
        added.push(`${name}.${field.name}`);
        continue;
      }
      if (existing.type !== field.type) {
        refused.push(
          `${name}.${field.name} would change from ${existing.type} to ${field.type}, ` +
            `which could not be done without risking existing values.`,
        );
      }
    }

    const dropped = def.fields.filter(
      (f) => !(next.fields ?? []).some((n) => n.name === f.name),
    );
    for (const field of dropped) {
      refused.push(`${name}.${field.name} would be removed, so it was kept.`);
    }

    collections[name] = { ...def, fields };
  }

  // A brand new collection is additive too, and is how an app grows a second list.
  for (const [name, def] of Object.entries(proposed.collections)) {
    if (!current.collections[name]) {
      collections[name] = def;
      added.push(`${name} (new list)`);
    }
  }

  return { schema: { collections }, added, refused };
}
