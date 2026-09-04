/**
 * Running an app, with no model involved.
 *
 * This file is where the thesis either holds or does not. Opening an app,
 * looking at it, adding a row, changing a value, deleting something: none of it
 * calls a model, touches the network, or costs a token. The interface is the
 * same every time because it is read from a file rather than generated, and the
 * behaviour is the same every time because it is the small deterministic set of
 * operations below rather than whatever a model decided this run.
 *
 * The operations are deliberately few. Every one of them is a thing a person
 * does to a list of records, and the schema says what a record is, so the
 * runtime can do all of it without understanding the domain. A tracker for job
 * applications and a tracker for physical therapy exercises are the same program
 * with different schemas, which is the whole reason a model only has to author
 * once.
 */

import type { Json } from "../core/spec.js";
import { getAt, setAt } from "../core/pointer.js";
import type { AppFile, CollectionDef, FieldDef } from "./format.js";

/** Everything a person can do to an app without a model. */
export type AppAction =
  /** Append the current draft to a collection, then clear the draft. */
  | { type: "add"; collection: string }
  /** Remove one record by index. */
  | { type: "remove"; collection: string; index: number }
  /** Change one field of one record. */
  | { type: "update"; collection: string; index: number; field: string; value: Json }
  /** Write a value anywhere in the data, used for draft fields and settings. */
  | { type: "set"; path: string; value: Json }
  /** Abandon the in-progress draft. */
  | { type: "clearDraft"; collection: string };

export interface ActionResult {
  app: AppFile;
  /** True when the data actually changed and the file needs saving. */
  changed: boolean;
  /** Why nothing happened, for a message the person can act on. */
  message?: string;
}

/** Where a collection's in-progress record lives while it is being filled in. */
export function draftPath(collection: string): string {
  return `/draft/${collection}`;
}

function emptyValue(field: FieldDef): Json {
  switch (field.type) {
    case "number":
      return 0;
    case "checkbox":
      return false;
    default:
      return "";
  }
}

/** A blank record shaped by the schema, so a form has every field from the start. */
export function blankRecord(def: CollectionDef): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const field of def.fields) out[field.name] = emptyValue(field);
  return out;
}

function isBlank(value: Json): boolean {
  if (value === "" || value === null || value === undefined) return true;
  return false;
}

/**
 * Validate a draft against the schema.
 *
 * Runs in the runtime rather than the model, so a required field is enforced on
 * every add forever, not on the adds that happened to be in the prompt.
 */
export function validateDraft(
  def: CollectionDef,
  draft: Record<string, Json>,
): string[] {
  const problems: string[] = [];
  for (const field of def.fields) {
    const value = draft[field.name];
    if (field.required && (value === undefined || isBlank(value))) {
      problems.push(`${field.label} is required.`);
      continue;
    }
    if (value === undefined || isBlank(value)) continue;

    if (field.type === "number" && typeof value !== "number") {
      problems.push(`${field.label} must be a number.`);
    }
    if (field.type === "select" && field.options && typeof value === "string") {
      if (!field.options.includes(value)) {
        problems.push(
          `${field.label} must be one of: ${field.options.join(", ")}.`,
        );
      }
    }
  }
  return problems;
}

/**
 * Apply an action. Pure with respect to the app: returns a new file rather than
 * mutating, so a caller can diff, undo, or discard without ceremony.
 */
export function applyAction(app: AppFile, action: AppAction): ActionResult {
  const data: Record<string, Json> = structuredClone(app.data);

  const collectionOf = (name: string): CollectionDef | undefined =>
    app.schema.collections[name];

  switch (action.type) {
    case "add": {
      const def = collectionOf(action.collection);
      if (!def) {
        return { app, changed: false, message: `No collection named ${action.collection}.` };
      }
      const draft = (getAt(data, draftPath(action.collection)) ?? {}) as Record<string, Json>;
      const problems = validateDraft(def, draft);
      if (problems.length > 0) {
        return { app, changed: false, message: problems.join(" ") };
      }

      const rows = getAt(data, def.path);
      const list: Json[] = Array.isArray(rows) ? [...rows] : [];
      // Fill from the schema so every stored record has every field, even the
      // ones the person left blank. A ragged collection breaks tables later.
      const record: Record<string, Json> = { ...blankRecord(def) };
      for (const field of def.fields) {
        if (draft[field.name] !== undefined) record[field.name] = draft[field.name]!;
      }
      list.push(record);

      setAt(data, def.path, list);
      setAt(data, draftPath(action.collection), blankRecord(def));
      return { app: { ...app, data }, changed: true };
    }

    case "remove": {
      const def = collectionOf(action.collection);
      if (!def) {
        return { app, changed: false, message: `No collection named ${action.collection}.` };
      }
      const rows = getAt(data, def.path);
      if (!Array.isArray(rows) || action.index < 0 || action.index >= rows.length) {
        return { app, changed: false, message: `There is no ${def.noun} at that position.` };
      }
      const list = [...rows];
      list.splice(action.index, 1);
      setAt(data, def.path, list);
      return { app: { ...app, data }, changed: true };
    }

    case "update": {
      const def = collectionOf(action.collection);
      if (!def) {
        return { app, changed: false, message: `No collection named ${action.collection}.` };
      }
      if (!def.fields.some((f) => f.name === action.field)) {
        return {
          app,
          changed: false,
          message: `${def.noun} has no field called ${action.field}.`,
        };
      }
      const rows = getAt(data, def.path);
      if (!Array.isArray(rows) || action.index < 0 || action.index >= rows.length) {
        return { app, changed: false, message: `There is no ${def.noun} at that position.` };
      }
      const list = [...rows];
      const row = { ...(list[action.index] as Record<string, Json>) };
      row[action.field] = action.value;
      list[action.index] = row;
      setAt(data, def.path, list);
      return { app: { ...app, data }, changed: true };
    }

    case "set": {
      try {
        setAt(data, action.path, action.value);
      } catch (err) {
        return {
          app,
          changed: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
      return { app: { ...app, data }, changed: true };
    }

    case "clearDraft": {
      const def = collectionOf(action.collection);
      if (!def) {
        return { app, changed: false, message: `No collection named ${action.collection}.` };
      }
      setAt(data, draftPath(action.collection), blankRecord(def));
      return { app: { ...app, data }, changed: true };
    }
  }
}

/**
 * Fill in anything the schema implies but the data does not yet have.
 *
 * Called on open. An app authored yesterday and edited today may have gained a
 * field, and this is what stops that from rendering as a hole. It never removes
 * data: a field dropped from the schema stays in old records, because deleting
 * someone's history to tidy a shape is not a decision software should make on
 * its own.
 */
export function hydrate(app: AppFile): AppFile {
  const data: Record<string, Json> = structuredClone(app.data);
  let changed = false;

  for (const [name, def] of Object.entries(app.schema.collections)) {
    if (!Array.isArray(getAt(data, def.path))) {
      setAt(data, def.path, []);
      changed = true;
    }
    const draft = getAt(data, draftPath(name));
    if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
      setAt(data, draftPath(name), blankRecord(def));
      changed = true;
    } else {
      const current = draft as Record<string, Json>;
      for (const field of def.fields) {
        if (current[field.name] === undefined) {
          current[field.name] = emptyValue(field);
          changed = true;
        }
      }
      setAt(data, draftPath(name), current);
    }
  }

  return changed ? { ...app, data } : app;
}

/** Rows of a collection, for rendering a table. */
export function records(app: AppFile, collection: string): Record<string, Json>[] {
  const def = app.schema.collections[collection];
  if (!def) return [];
  const rows = getAt(app.data, def.path);
  return Array.isArray(rows) ? (rows as Record<string, Json>[]) : [];
}
