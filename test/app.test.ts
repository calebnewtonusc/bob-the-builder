/**
 * The app layer, which is where the project's actual claim lives: software that
 * gets built once and stays built.
 *
 * Two properties are load-bearing and both are tested here directly, because
 * they are the difference between this and every other generative UI tool:
 *
 *   1. Running an app never involves a model. Open it, add to it, change a
 *      value: all local, all deterministic, byte-identical every time.
 *   2. Editing the interface never touches the data. You can restyle an app you
 *      have used for a year without risking the year.
 */

import { describe, expect, it } from "vitest";
import { appCatalog } from "../src/app/catalog.js";
import {
  applyAction,
  blankRecord,
  draftPath,
  hydrate,
  records,
  validateDraft,
} from "../src/app/runtime.js";
import {
  createApp,
  parseApp,
  serializeApp,
  slugify,
  migrateSchema,
  viewAtRevision,
  type AppFile,
  type CollectionDef,
} from "../src/app/format.js";
import { authorApp, editApp, parseAuthored, AuthorError } from "../src/app/author.js";
import { renderApp } from "../src/app/render-text.js";
import { defineAdapter } from "../src/eval/adapter.js";
import { parseLines } from "../src/core/lines.js";
import { SurfaceStore } from "../src/core/store.js";
import { auditA11y } from "../src/audit/a11y.js";
import { appExists, availableId, loadApp, saveApp } from "../src/app/store.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COLLECTION: CollectionDef = {
  path: "/applications",
  noun: "application",
  fields: [
    { name: "company", label: "Company", type: "text", required: true },
    { name: "status", label: "Status", type: "select", options: ["Applied", "Offer"] },
    { name: "salary", label: "Salary", type: "number" },
  ],
};

const VIEW_SOURCE = `c app Screen title="Applications"
r app
> app total table company addBtn
c total Metric label="Applications" value={"$count":"/applications"}
c table Table caption="All applications" collection=applications rows=@/applications columns=[{"field":"company","label":"Company"}]
c company Field label="Company" value=@/draft/applications/company
c addBtn Button label="Add application" action=add collection=applications
`;

function testApp(): AppFile {
  const store = new SurfaceStore({ catalog: appCatalog, mode: "strict" });
  store.apply(parseLines(VIEW_SOURCE));
  return hydrate(
    createApp({
      id: "applications",
      title: "Applications",
      catalog: "personal",
      schema: { collections: { applications: COLLECTION } },
      view: store.snapshot,
    }),
  );
}

describe("the built-in catalog", () => {
  it("passes its own accessibility audit", () => {
    // The catalog every app is built from had better clear the bar the project
    // asks everyone else's catalog to clear.
    const report = auditA11y(appCatalog);
    expect(report.errors).toBe(0);
  });
});

describe("app files", () => {
  it("round trips through serialize and parse", () => {
    const app = testApp();
    const back = parseApp(JSON.parse(serializeApp(app)));
    expect(back.id).toBe(app.id);
    expect(back.view.root).toBe("app");
    expect(back.schema.collections["applications"]!.fields).toHaveLength(3);
  });

  it("refuses a file from a newer format rather than guessing", () => {
    const app = { ...testApp(), version: 99 };
    expect(() => parseApp(app)).toThrow(/version 99/);
  });

  it("refuses a view with no root, which would render nothing", () => {
    const app = testApp();
    expect(() => parseApp({ ...app, view: { ...app.view, root: null } })).toThrow(/no root/);
  });

  it("makes filesystem-safe ids from any title", () => {
    expect(slugify("Job applications!")).toBe("job-applications");
    expect(slugify("  Reading  Log  ")).toBe("reading-log");
    expect(slugify("!!!")).toBe("app");
  });
});

describe("running an app, with no model", () => {
  it("hydrates missing collections and drafts from the schema", () => {
    const app = testApp();
    expect(records(app, "applications")).toEqual([]);
    expect(app.data["draft"]).toEqual({
      applications: { company: "", status: "", salary: 0 },
    });
  });

  it("adds a record and clears the draft", () => {
    let app = testApp();
    app = applyAction(app, {
      type: "set",
      path: `${draftPath("applications")}/company`,
      value: "Anthropic",
    }).app;

    const result = applyAction(app, { type: "add", collection: "applications" });
    expect(result.changed).toBe(true);
    expect(records(result.app, "applications")).toHaveLength(1);
    expect(records(result.app, "applications")[0]!["company"]).toBe("Anthropic");
    // Draft is cleared, so the next entry starts blank rather than duplicating.
    expect(result.app.data["draft"]).toEqual({
      applications: { company: "", status: "", salary: 0 },
    });
  });

  it("refuses to add a record missing a required field", () => {
    const result = applyAction(testApp(), { type: "add", collection: "applications" });
    expect(result.changed).toBe(false);
    expect(result.message).toMatch(/Company is required/);
  });

  it("stores every schema field, even the ones left blank", () => {
    // A ragged collection breaks tables later, so records are filled from the
    // schema rather than from whatever the draft happened to contain.
    let app = testApp();
    app = applyAction(app, {
      type: "set",
      path: `${draftPath("applications")}/company`,
      value: "LEMMA",
    }).app;
    app = applyAction(app, { type: "add", collection: "applications" }).app;
    expect(Object.keys(records(app, "applications")[0]!).sort()).toEqual([
      "company",
      "salary",
      "status",
    ]);
  });

  it("removes a record by position", () => {
    let app = testApp();
    for (const name of ["A", "B"]) {
      app = applyAction(app, {
        type: "set",
        path: `${draftPath("applications")}/company`,
        value: name,
      }).app;
      app = applyAction(app, { type: "add", collection: "applications" }).app;
    }
    const result = applyAction(app, { type: "remove", collection: "applications", index: 0 });
    expect(records(result.app, "applications")).toHaveLength(1);
    expect(records(result.app, "applications")[0]!["company"]).toBe("B");
  });

  it("refuses to remove a record that does not exist", () => {
    const result = applyAction(testApp(), {
      type: "remove",
      collection: "applications",
      index: 7,
    });
    expect(result.changed).toBe(false);
    expect(result.message).toMatch(/no application at that position/i);
  });

  it("updates one field of one record", () => {
    let app = testApp();
    app = applyAction(app, {
      type: "set",
      path: `${draftPath("applications")}/company`,
      value: "Anthropic",
    }).app;
    app = applyAction(app, { type: "add", collection: "applications" }).app;

    const result = applyAction(app, {
      type: "update",
      collection: "applications",
      index: 0,
      field: "status",
      value: "Offer",
    });
    expect(records(result.app, "applications")[0]!["status"]).toBe("Offer");
  });

  it("refuses to update a field the schema does not have", () => {
    let app = testApp();
    app = applyAction(app, {
      type: "set",
      path: `${draftPath("applications")}/company`,
      value: "x",
    }).app;
    app = applyAction(app, { type: "add", collection: "applications" }).app;
    const result = applyAction(app, {
      type: "update",
      collection: "applications",
      index: 0,
      field: "invented",
      value: 1,
    });
    expect(result.changed).toBe(false);
  });

  it("never mutates the app it was given", () => {
    const app = testApp();
    const snapshot = JSON.stringify(app);
    applyAction(app, {
      type: "set",
      path: `${draftPath("applications")}/company`,
      value: "mutated?",
    });
    expect(JSON.stringify(app)).toBe(snapshot);
  });

  it("validates against the schema, not against what a model remembered", () => {
    expect(validateDraft(COLLECTION, { company: "", status: "", salary: 0 })).toContain(
      "Company is required.",
    );
    expect(
      validateDraft(COLLECTION, { company: "A", status: "Nope", salary: 0 }),
    ).toContainEqual(expect.stringContaining("must be one of"));
    expect(
      validateDraft(COLLECTION, { company: "A", status: "Offer", salary: "lots" }),
    ).toContainEqual(expect.stringContaining("must be a number"));
    expect(validateDraft(COLLECTION, { company: "A", status: "Offer", salary: 1 })).toEqual([]);
  });

  it("renders identically every time, because nothing generates it", () => {
    const app = testApp();
    const once = renderApp(app, { plain: true });
    const twice = renderApp(app, { plain: true });
    expect(once).toBe(twice);
    expect(once).toContain("Applications");
  });

  it("computes counts from the data rather than storing them", () => {
    let app = testApp();
    expect(renderApp(app, { plain: true })).toMatch(/0\s+Applications/);
    app = applyAction(app, {
      type: "set",
      path: `${draftPath("applications")}/company`,
      value: "A",
    }).app;
    app = applyAction(app, { type: "add", collection: "applications" }).app;
    expect(renderApp(app, { plain: true })).toMatch(/1\s+Applications/);
  });

  it("fills in a field added to the schema after records already existed", () => {
    let app = testApp();
    app = applyAction(app, {
      type: "set",
      path: `${draftPath("applications")}/company`,
      value: "A",
    }).app;
    app = applyAction(app, { type: "add", collection: "applications" }).app;

    const grown: AppFile = {
      ...app,
      schema: {
        collections: {
          applications: {
            ...COLLECTION,
            fields: [...COLLECTION.fields, { name: "notes", label: "Notes", type: "text" }],
          },
        },
      },
    };
    const after = hydrate(grown);
    expect((after.data["draft"] as Record<string, Record<string, unknown>>)["applications"])
      .toHaveProperty("notes");
    // Existing records are left alone: deleting history to tidy a shape is not a
    // decision software should make on its own.
    expect(records(after, "applications")[0]).not.toHaveProperty("notes");
  });

  it("blankRecord shapes an empty record by field type", () => {
    expect(blankRecord(COLLECTION)).toEqual({ company: "", status: "", salary: 0 });
  });
});

describe("authoring", () => {
  const AUTHORED = `t Reading log
why A list of books with what you thought of each.
schema {"collections":{"books":{"path":"/books","noun":"book","fields":[{"name":"title","label":"Title","type":"text","required":true}]}}}
c app Screen title="Reading log"
r app
> app table
c table Table caption="Books" collection=books rows=@/books columns=[{"field":"title","label":"Title"}]
`;

  it("parses a well-formed authoring response", () => {
    const authored = parseAuthored(AUTHORED);
    expect(authored.title).toBe("Reading log");
    expect(authored.summary).toMatch(/list of books/);
    expect(authored.schema.collections["books"]!.noun).toBe("book");
    expect(authored.ops.some((op) => op.op === "root")).toBe(true);
  });

  it("refuses a response with no schema", () => {
    expect(() => parseAuthored("t X\nc a Screen title=X\nr a\n")).toThrow(/no schema line/);
  });

  it("refuses a response whose view never declares a root", () => {
    const noRoot = AUTHORED.split("\n").filter((l) => l !== "r app").join("\n");
    expect(() => parseAuthored(noRoot)).toThrow(/never declared a root/);
  });

  it("refuses a schema whose collection has no fields", () => {
    const bad = AUTHORED.replace('"fields":[{"name":"title","label":"Title","type":"text","required":true}]', '"fields":[]');
    expect(() => parseAuthored(bad)).toThrow(/no fields/);
  });

  it("builds a runnable app end to end", async () => {
    const adapter = defineAdapter("test", async function* () {
      yield AUTHORED;
    });
    const { app } = await authorApp(adapter, "track what I read", appCatalog);
    expect(app.id).toBe("reading-log");
    expect(app.view.root).toBe("app");
    expect(records(app, "books")).toEqual([]);
    expect(app.history).toHaveLength(1);
    expect(app.history[0]!.request).toBe("track what I read");
  });
});

describe("editing, which must never touch the data", () => {
  async function withRecords(): Promise<AppFile> {
    let app = testApp();
    for (const name of ["Anthropic", "LEMMA"]) {
      app = applyAction(app, {
        type: "set",
        path: `${draftPath("applications")}/company`,
        value: name,
      }).app;
      app = applyAction(app, { type: "add", collection: "applications" }).app;
    }
    return app;
  }

  const EDIT = `why Renamed the table caption.
c table Table caption="Applications this year" collection=applications rows=@/applications columns=[{"field":"company","label":"Company"}]
`;

  it("patches the view and leaves every record untouched", async () => {
    const before = await withRecords();
    const adapter = defineAdapter("test", async function* () {
      yield EDIT;
    });
    const { app } = await editApp(adapter, before, "rename the table", appCatalog);

    expect(app.view.elements["table"]!.props["caption"]).toBe("Applications this year");
    expect(records(app, "applications")).toEqual(records(before, "applications"));
    expect(app.data).toEqual(before.data);
  });

  it("leaves components the edit did not mention exactly as they were", async () => {
    // The whole reason an edit is a patch rather than a regeneration.
    const before = await withRecords();
    const adapter = defineAdapter("test", async function* () {
      yield EDIT;
    });
    const { app } = await editApp(adapter, before, "rename the table", appCatalog);
    expect(app.view.elements["company"]).toEqual(before.view.elements["company"]);
    expect(app.view.elements["addBtn"]).toEqual(before.view.elements["addBtn"]);
    expect(app.view.root).toBe(before.view.root);
  });

  it("refuses an edit that tries to write into the data", async () => {
    // A model reaching for the records during a layout change is a hard stop,
    // not a warning: the person asked to change the interface.
    const before = await withRecords();
    const adapter = defineAdapter("test", async function* () {
      yield `why Sneaky.\nd /applications/0/company "Rewritten"\n`;
    });
    await expect(
      editApp(adapter, before, "rename the table", appCatalog),
    ).rejects.toThrow(/never the records/);
  });

  it("records every change in history, with what was asked", async () => {
    const before = await withRecords();
    const adapter = defineAdapter("test", async function* () {
      yield EDIT;
    });
    const { app } = await editApp(adapter, before, "rename the table", appCatalog);
    expect(app.history).toHaveLength(before.history.length + 1);
    const last = app.history[app.history.length - 1]!;
    expect(last.request).toBe("rename the table");
    expect(last.summary).toMatch(/Renamed/);
    expect(last.ops.length).toBeGreaterThan(0);
  });

  it("refuses an edit that changes nothing", async () => {
    const adapter = defineAdapter("test", async function* () {
      yield "why Nothing to do.\n";
    });
    await expect(
      editApp(adapter, testApp(), "do nothing", appCatalog),
    ).rejects.toThrow(AuthorError);
  });

  it("can reconstruct any earlier view from history alone", async () => {
    // Ops are stored rather than replacements, so replaying up to a point
    // rebuilds a prior view exactly. That is what makes an edit revertible, and
    // it needs the app's creation to be in history, so this starts from author.
    const author = defineAdapter("test", async function* () {
      yield `t Applications
why Tracks applications.
schema {"collections":{"applications":{"path":"/applications","noun":"application","fields":[{"name":"company","label":"Company","type":"text","required":true}]}}}
${VIEW_SOURCE}`;
    });
    const { app: created } = await authorApp(author, "track applications", appCatalog);

    const editor = defineAdapter("test", async function* () {
      yield EDIT;
    });
    const { app } = await editApp(editor, created, "rename the table", appCatalog);
    expect(app.view.elements["table"]!.props["caption"]).toBe("Applications this year");

    const store = new SurfaceStore({ catalog: appCatalog });
    store.apply(viewAtRevision(app, app.history.length - 1));
    expect(store.snapshot.elements["table"]!.props["caption"]).toBe("All applications");
  });

  it("refuses to rebuild a revision it cannot actually reconstruct", async () => {
    // An app assembled by hand has no genesis ops, so a replay would produce a
    // blank view that looks like a successful revert. It fails loudly instead.
    const before = await withRecords();
    expect(() => viewAtRevision(before, 1)).not.toThrow();
    const adapter = defineAdapter("test", async function* () {
      yield EDIT;
    });
    const { app } = await editApp(adapter, before, "rename", appCatalog);
    expect(() => viewAtRevision(app, 1)).toThrow(/does not include/);
  });
});

describe("overwrite protection", () => {
  /**
   * The worst bug found auditing the app layer. `bob make` with a title matching
   * an existing app silently replaced it, records and all, which is exactly the
   * thing the project promises cannot happen.
   */
  it("finds a free id near the one you wanted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bob-test-"));
    const app = testApp();
    await saveApp(app, dir);

    expect(await appExists("applications", dir)).toBe(true);
    expect(await availableId("applications", dir)).toBe("applications-2");

    await saveApp({ ...app, id: "applications-2" }, dir);
    expect(await availableId("applications", dir)).toBe("applications-3");
  });

  it("leaves an untouched id alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bob-test-"));
    expect(await availableId("brand-new", dir)).toBe("brand-new");
    expect(await appExists("brand-new", dir)).toBe(false);
  });

  it("round trips an app through the filesystem with its records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bob-test-"));
    let app = testApp();
    app = applyAction(app, {
      type: "set",
      path: `${draftPath("applications")}/company`,
      value: "Anthropic",
    }).app;
    app = applyAction(app, { type: "add", collection: "applications" }).app;

    await saveApp(app, dir);
    const back = await loadApp(app.id, dir);
    expect(records(back, "applications")).toHaveLength(1);
    expect(records(back, "applications")[0]!["company"]).toBe("Anthropic");
  });
});

describe("surviving a real model", () => {
  const CLEAN = `t Reading log
why Books with a rating.
schema {"collections":{"books":{"path":"/books","noun":"book","fields":[{"name":"title","label":"Title","type":"text","required":true},{"name":"rating","label":"Rating","type":"number"}]}}}
c app Screen title="Reading log"
r app
> app avg table
c avg Metric label="Average rating" value={"$avg":"/books","field":"rating"}
c table Table caption="Books" collection=books rows=@/books columns=[{"field":"title","label":"Title"}]
`;

  /**
   * The first live run against a real model failed on the first line, because
   * the answer opened with a sentence. Told plainly to emit lines and nothing
   * else, real models still add preamble, code fences, and closing commentary.
   */
  it("ignores preamble and closing commentary", () => {
    const wrapped = `Here is the app you asked for.\n\n${CLEAN}\nLet me know if you want anything changed.`;
    const authored = parseAuthored(wrapped);
    expect(authored.title).toBe("Reading log");
    expect(authored.ops.some((op) => op.op === "root")).toBe(true);
  });

  it("ignores markdown code fences", () => {
    const authored = parseAuthored("```\n" + CLEAN + "```\n");
    expect(authored.title).toBe("Reading log");
  });

  it("ignores a paragraph that happens to start with a verb word", () => {
    // "c" and "r" begin plenty of English sentences. A line only survives if it
    // also parses as an op.
    const authored = parseAuthored(
      `c'est la vie, here is your app\nr you ready for this?\n${CLEAN}`,
    );
    expect(authored.ops.filter((op) => op.op === "root")).toHaveLength(1);
  });

  it("still refuses an answer that is only prose", () => {
    // Tolerance about framing must not become tolerance about substance.
    expect(() =>
      parseAuthored("I would be happy to help you build a reading tracker!"),
    ).toThrow(/no schema line/);
  });
});

describe("computed averages", () => {
  /**
   * A real model reached for {"$avg": …} on a book tracker unprompted, and it
   * was silently dropped because only $count and $sum existed. Every computed
   * form here earned its place by a model wanting it.
   */
  const collection: CollectionDef = {
    path: "/books",
    noun: "book",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "rating", label: "Rating", type: "number" },
    ],
  };

  function ratingApp(): AppFile {
    const store = new SurfaceStore({ catalog: appCatalog, mode: "strict" });
    store.apply(
      parseLines(`c app Screen title="Reading log"
r app
> app avg total
c avg Metric label="Average rating" value={"$avg":"/books","field":"rating"}
c total Metric label="Rating total" value={"$sum":"/books","field":"rating"}
`),
    );
    return hydrate(
      createApp({
        id: "reading",
        title: "Reading log",
        catalog: "personal",
        schema: { collections: { books: collection } },
        view: store.snapshot,
      }),
    );
  }

  function withRatings(...ratings: number[]): AppFile {
    let app = ratingApp();
    for (const rating of ratings) {
      app = applyAction(app, {
        type: "set",
        path: `${draftPath("books")}/title`,
        value: `Book ${rating}`,
      }).app;
      app = applyAction(app, {
        type: "set",
        path: `${draftPath("books")}/rating`,
        value: rating,
      }).app;
      app = applyAction(app, { type: "add", collection: "books" }).app;
    }
    return app;
  }

  it("averages, rounded to one place", () => {
    // 4.333… is not what anyone meant by "average rating".
    expect(renderApp(withRatings(5, 4, 4), { plain: true })).toMatch(/4\.3\s+Average rating/);
  });

  it("reads zero over an empty collection rather than NaN", () => {
    expect(renderApp(ratingApp(), { plain: true })).toMatch(/0\s+Average rating/);
  });

  it("sums independently of averaging", () => {
    expect(renderApp(withRatings(5, 4, 3), { plain: true })).toMatch(/12\s+Rating total/);
  });
});

describe("schema migration", () => {
  /**
   * A real `bob change` added a Notes input to the view without adding the field
   * to the schema, producing an app that looked correct and was broken: the
   * input rendered and nothing could ever be saved into it.
   */
  const base = { collections: { books: { path: "/books", noun: "book", fields: [
    { name: "title", label: "Title", type: "text" as const, required: true },
    { name: "rating", label: "Rating", type: "number" as const },
  ] } } };

  it("adds a new field", () => {
    const proposed = { collections: { books: { ...base.collections.books, fields: [
      ...base.collections.books.fields,
      { name: "notes", label: "Notes", type: "text" as const },
    ] } } };
    const migration = migrateSchema(base, proposed);
    expect(migration.added).toEqual(["books.notes"]);
    expect(migration.refused).toEqual([]);
    expect(migration.schema.collections["books"]!.fields).toHaveLength(3);
  });

  it("refuses to remove a field, and keeps it", () => {
    // Someone asking for a notes column has not asked to lose their ratings.
    const proposed = { collections: { books: { ...base.collections.books, fields: [
      { name: "title", label: "Title", type: "text" as const, required: true },
    ] } } };
    const migration = migrateSchema(base, proposed);
    expect(migration.schema.collections["books"]!.fields).toHaveLength(2);
    expect(migration.refused.join(" ")).toMatch(/rating would be removed/);
  });

  it("refuses to retype a field, and keeps the original type", () => {
    const proposed = { collections: { books: { ...base.collections.books, fields: [
      { name: "title", label: "Title", type: "text" as const, required: true },
      { name: "rating", label: "Rating", type: "text" as const },
    ] } } };
    const migration = migrateSchema(base, proposed);
    expect(migration.schema.collections["books"]!.fields[1]!.type).toBe("number");
    expect(migration.refused.join(" ")).toMatch(/number to text/);
  });

  it("accepts a whole new collection", () => {
    const proposed = { collections: { ...base.collections, notes: {
      path: "/notes", noun: "note",
      fields: [{ name: "body", label: "Body", type: "text" as const }],
    } } };
    const migration = migrateSchema(base, proposed);
    expect(migration.added).toContain("notes (new list)");
    expect(Object.keys(migration.schema.collections).sort()).toEqual(["books", "notes"]);
  });

  it("applies through an edit, so the new input actually works", async () => {
    let app = testApp();
    app = applyAction(app, {
      type: "set",
      path: `${draftPath("applications")}/company`,
      value: "Anthropic",
    }).app;
    app = applyAction(app, { type: "add", collection: "applications" }).app;

    const withNotes = JSON.stringify({
      collections: {
        applications: {
          ...app.schema.collections["applications"],
          fields: [
            ...app.schema.collections["applications"]!.fields,
            { name: "notes", label: "Notes", type: "text" },
          ],
        },
      },
    });

    const adapter = defineAdapter("test", async function* () {
      yield `why Added notes.
schema ${withNotes}
c notesField Field label="Notes" value=@/draft/applications/notes
> app total table company addBtn notesField
`;
    });

    const { app: next, addedFields } = await editApp(adapter, app, "add notes", appCatalog);
    expect(addedFields).toEqual(["applications.notes"]);
    // The draft now has the field, so `set` and `add` will accept it.
    const draft = (next.data["draft"] as Record<string, Record<string, unknown>>)["applications"]!;
    expect(draft).toHaveProperty("notes");
    // And the existing record is untouched.
    expect(records(next, "applications")).toHaveLength(1);
    expect(records(next, "applications")[0]!["company"]).toBe("Anthropic");
  });
});
