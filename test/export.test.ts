/**
 * @vitest-environment jsdom
 *
 * The exported HTML file, exercised as a browser would.
 *
 * This file is the answer to "can you hand it to someone who does not use a
 * terminal", so it is worth testing as a real page rather than as a string.
 * Everything below runs the actual embedded runtime: no model, no network, no
 * dependencies.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { appCatalog } from "../src/app/catalog.js";
import { createApp, type AppFile, type CollectionDef } from "../src/app/format.js";
import { applyAction, draftPath, hydrate } from "../src/app/runtime.js";
import { exportHtml } from "../src/app/export-html.js";
import { SurfaceStore } from "../src/core/store.js";
import { parseLines } from "../src/core/lines.js";

const collection: CollectionDef = {
  path: "/books",
  noun: "book",
  fields: [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "rating", label: "Rating", type: "number" },
    { name: "finished", label: "Finished", type: "checkbox" },
  ],
};

const VIEW = `c app Screen title="Reading log"
r app
> app stats table form
c stats Stack direction=horizontal gap=3
> stats total avg
c total Metric label="Books" value={"$count":"/books"}
c avg Metric label="Average rating" value={"$avg":"/books","field":"rating"}
c table Table caption="Books" collection=books rows=@/books removable=true columns=[{"field":"title","label":"Title"},{"field":"rating","label":"Rating"}]
c form Stack gap=2
> form titleF ratingF finishedF addBtn
c titleF Field label="Title" value=@/draft/books/title
c ratingF Field label="Rating" kind=number value=@/draft/books/rating
c finishedF Checkbox label="Finished" value=@/draft/books/finished
c addBtn Button label="Add book" action=add collection=books variant=primary
`;

function makeApp(): AppFile {
  const store = new SurfaceStore({ catalog: appCatalog, mode: "strict" });
  store.apply(parseLines(VIEW));
  let app = hydrate(
    createApp({
      id: "reading-log",
      title: "Reading log",
      catalog: "personal",
      schema: { collections: { books: collection } },
      view: store.snapshot,
    }),
  );
  app = applyAction(app, {
    type: "set",
    path: `${draftPath("books")}/title`,
    value: "Turtle Island",
  }).app;
  app = applyAction(app, {
    type: "set",
    path: `${draftPath("books")}/rating`,
    value: 5,
  }).app;
  return applyAction(app, { type: "add", collection: "books" }).app;
}

/** Load the exported file into the current jsdom document and run its script. */
function open(app: AppFile): void {
  const html = exportHtml(app);
  const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
  document.body.innerHTML = body.replace(/<script>[\s\S]*<\/script>/, "");

  const script = html.slice(
    html.indexOf("<script>") + 8,
    html.lastIndexOf("</script>"),
  );
  // Run it the way a browser would, then fire the load event it waits for.
  new Function(script)();
  document.dispatchEvent(new Event("DOMContentLoaded"));
}

const text = (): string => document.body.textContent ?? "";
const byLabel = (label: string): HTMLElement | null => {
  for (const el of Array.from(document.querySelectorAll("label"))) {
    if (el.textContent?.trim().startsWith(label)) {
      return el.querySelector("input, select");
    }
  }
  return null;
};
const button = (name: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === name,
  );

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("the exported HTML file", () => {
  it("has no network requests of any kind", () => {
    // The whole promise is that it works offline, forever, on a plane.
    const html = exportHtml(makeApp());
    expect(html).not.toMatch(/src=["']http/);
    expect(html).not.toMatch(/href=["']http/);
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest|import\(/);
  });

  it("renders the app, its records, and its computed values", () => {
    open(makeApp());
    expect(document.querySelector("h1")?.textContent).toBe("Reading log");
    expect(text()).toContain("Turtle Island");
    expect(document.querySelector('[aria-label="Books"]')?.textContent).toContain("1");
    expect(document.querySelector('[aria-label="Average rating"]')?.textContent).toContain("5");
  });

  it("adds a record and updates the counts, with no model anywhere", () => {
    open(makeApp());
    const title = byLabel("Title") as HTMLInputElement;
    title.value = "Pocket Disciple";
    title.dispatchEvent(new Event("input", { bubbles: true }));

    const rating = byLabel("Rating") as HTMLInputElement;
    rating.value = "4";
    rating.dispatchEvent(new Event("input", { bubbles: true }));

    button("Add book")!.click();

    expect(text()).toContain("Pocket Disciple");
    expect(document.querySelector('[aria-label="Books"]')?.textContent).toContain("2");
    // (5 + 4) / 2, rounded to one place.
    expect(document.querySelector('[aria-label="Average rating"]')?.textContent).toContain("4.5");
  });

  it("clears the draft after adding, so the next entry starts blank", () => {
    open(makeApp());
    const title = byLabel("Title") as HTMLInputElement;
    title.value = "Another";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    button("Add book")!.click();
    expect((byLabel("Title") as HTMLInputElement).value).toBe("");
  });

  it("enforces the schema's required fields", () => {
    open(makeApp());
    const before = document.querySelectorAll("tbody tr").length;
    button("Add book")!.click();
    expect(document.querySelectorAll("tbody tr").length).toBe(before);
  });

  it("deletes a record", () => {
    open(makeApp());
    expect(text()).toContain("Turtle Island");
    Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent === "Delete")!
      .click();
    expect(text()).not.toContain("Turtle Island");
  });

  it("persists to localStorage and reloads what was entered", () => {
    open(makeApp());
    const title = byLabel("Title") as HTMLInputElement;
    title.value = "Saved across reloads";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    button("Add book")!.click();

    // Reopening is what happens when the person closes the tab and comes back.
    document.body.innerHTML = "";
    open(makeApp());
    expect(text()).toContain("Saved across reloads");
  });

  it("carries a live region so results are announced", () => {
    open(makeApp());
    const live = document.querySelector('[aria-live="polite"][role="status"]');
    expect(live).not.toBeNull();
  });

  it("gives the table a caption and column headers", () => {
    open(makeApp());
    expect(document.querySelector("caption")?.textContent).toBe("Books");
    const headers = Array.from(document.querySelectorAll("th")).map((h) => h.textContent);
    expect(headers).toContain("Title");
  });

  it("escapes a title that contains markup", () => {
    const app = { ...makeApp(), title: '</title><script>alert(1)</script>' };
    const html = exportHtml(app);
    expect(html).not.toContain("</title><script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes angle brackets inside the embedded data", () => {
    // A record containing "</script>" must not be able to close the tag it
    // lives in. This is the one injection route an offline file still has.
    let app = makeApp();
    app = applyAction(app, {
      type: "set",
      path: `${draftPath("books")}/title`,
      value: "</script><script>alert(1)</script>",
    }).app;
    app = applyAction(app, { type: "add", collection: "books" }).app;

    const html = exportHtml(app);
    const scripts = html.split("</script>").length - 1;
    expect(scripts).toBe(1);
    expect(html).toContain("\\u003c/script");
  });
});

describe("validation in the exported file", () => {
  it("shows the problem inline instead of blocking with an alert", () => {
    // alert() blocks the page, loses the person's place, and is unusable on a
    // phone. The message belongs beside the form and in the live region.
    open(makeApp());
    button("Add book")!.click();
    const problem = document.querySelector('[role="alert"]');
    expect(problem).not.toBeNull();
    expect(problem?.textContent).toContain("Title is required");
  });

  it("clears the problem once the record saves", () => {
    open(makeApp());
    button("Add book")!.click();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    const title = byLabel("Title") as HTMLInputElement;
    title.value = "Now valid";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    button("Add book")!.click();

    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain("Now valid");
  });
});
