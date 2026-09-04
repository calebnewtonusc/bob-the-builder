/**
 * Export an app as one self-contained HTML file.
 *
 * This closes the last honest gap. A terminal renderer proves the architecture
 * and a React component serves developers, but neither is a thing you can hand
 * to someone who does not use a terminal. An HTML file is: it opens by
 * double-clicking, works offline, works on a phone, and can be emailed.
 *
 * Everything is inlined, so the file has no dependencies, no network calls, and
 * no build step. It contains the app's view, schema, data, and a small runtime
 * that implements the same actions `src/app/runtime.ts` does, which is why it
 * behaves identically and why there is no model anywhere in it.
 *
 * Edits made in the page persist to `localStorage` and can be exported back to
 * JSON, so the file stays the source of truth and nothing is trapped.
 */

import type { AppFile } from "./format.js";

/** JSON safe to embed inside a script tag. */
function embed(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --surface: #fff; --ink: #17181a; --ink-2: #55595f;
  --line: #e2e4e7; --accent: #1f6f78; --accent-ink: #fff; --danger: #a23b2c;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --surface: #1c1f24; --ink: #eceef1; --ink-2: #a3aab3;
    --line: #2b3037; --accent: #4fb3bd; --accent-ink: #0d1013; --danger: #e0765f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 24px 16px 64px;
}
main { max-width: 760px; margin: 0 auto; }
h1 { font-size: 1.65rem; letter-spacing: -0.02em; margin: 0 0 20px; }
h2 { font-size: 1.05rem; letter-spacing: -0.01em; margin: 24px 0 10px; }
p { color: var(--ink-2); margin: 0 0 10px; }
.row { display: flex; flex-wrap: wrap; gap: 12px; }
.col { display: flex; flex-direction: column; gap: 12px; }
.metric {
  flex: 1 1 130px; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 14px 16px;
}
.metric b { display: block; font-size: 1.9rem; letter-spacing: -0.03em; }
.metric span { color: var(--ink-2); font-size: 0.85rem; }
.card {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 16px; overflow-x: auto;
}
table { width: 100%; border-collapse: collapse; font-size: 0.94rem; }
caption { text-align: left; font-weight: 600; padding-bottom: 10px; }
th, td { text-align: left; padding: 9px 12px 9px 0; border-bottom: 1px solid var(--line); }
th { font-size: 0.76rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2); }
tbody tr:last-child td { border-bottom: 0; }
label { display: flex; flex-direction: column; gap: 5px; font-size: 0.85rem; color: var(--ink-2); }
label.inline { flex-direction: row; align-items: center; gap: 8px; }
input, select {
  font: inherit; color: var(--ink); background: var(--bg);
  border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; width: 100%;
}
input[type="checkbox"] { width: auto; }
input:focus-visible, select:focus-visible, button:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
button {
  font: inherit; font-weight: 550; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink);
  border-radius: 8px; padding: 9px 15px;
}
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button.link { border: 0; background: none; color: var(--danger); padding: 4px 6px; }
.empty { color: var(--ink-2); padding: 10px 0; }
.problem { color: var(--danger); border: 1px solid var(--danger); background: var(--surface);
           border-radius: 8px; padding: 10px 13px; margin-top: 12px; }
.bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
       margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--line);
       font-size: 0.82rem; color: var(--ink-2); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 560px) { body { padding: 16px 12px 56px; } h1 { font-size: 1.4rem; } }
`;

/**
 * The runtime, as a string.
 *
 * A deliberate reimplementation of `applyAction`, `hydrate` and the computed
 * props, kept short enough to read in one sitting. Bundling the TypeScript would
 * mean a build step and a bundler in the dependency tree of a file whose whole
 * value is having neither.
 */
const RUNTIME = String.raw`
const $ = (sel, root) => (root || document).querySelector(sel);

function getAt(root, pointer) {
  if (!pointer || pointer === "/") return root;
  let cur = root;
  for (const seg of pointer.slice(1).split("/")) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
  }
  return cur;
}

function setAt(root, pointer, value) {
  const segs = pointer.slice(1).split("/");
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = segs[i + 1];
    if (cur[segs[i]] == null || typeof cur[segs[i]] !== "object") {
      cur[segs[i]] = /^\d+$/.test(next) ? [] : {};
    }
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
  return root;
}

function compute(expr, data) {
  if (expr.$count !== undefined) {
    const rows = getAt(data, expr.$count);
    if (!Array.isArray(rows)) return 0;
    if (!expr.where) return rows.length;
    return rows.filter((r) => r && r[expr.where.field] === expr.where.equals).length;
  }
  const path = expr.$sum !== undefined ? expr.$sum : expr.$avg;
  const rows = getAt(data, path);
  if (!Array.isArray(rows)) return 0;
  let total = 0, n = 0;
  for (const row of rows) {
    const v = row && row[expr.field];
    if (typeof v === "number" && isFinite(v)) { total += v; n++; }
  }
  if (expr.$sum !== undefined) return total;
  return n === 0 ? 0 : Math.round((total / n) * 10) / 10;
}

function resolve(props, data) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v && typeof v === "object" && typeof v.$bind === "string") {
      const r = getAt(data, v.$bind);
      if (r !== undefined) out[k] = r;
    } else if (v && typeof v === "object" && (v.$count !== undefined || v.$sum !== undefined || v.$avg !== undefined)) {
      out[k] = compute(v, data);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const blank = (def) => {
  const r = {};
  for (const f of def.fields) r[f.name] = f.type === "number" ? 0 : f.type === "checkbox" ? false : "";
  return r;
};

function hydrate(app) {
  for (const [name, def] of Object.entries(app.schema.collections)) {
    if (!Array.isArray(getAt(app.data, def.path))) setAt(app.data, def.path, []);
    const draft = getAt(app.data, "/draft/" + name);
    if (!draft || typeof draft !== "object") setAt(app.data, "/draft/" + name, blank(def));
    else for (const f of def.fields) if (draft[f.name] === undefined) draft[f.name] = f.type === "number" ? 0 : f.type === "checkbox" ? false : "";
  }
  return app;
}

function validate(def, draft) {
  const problems = [];
  for (const f of def.fields) {
    const v = draft[f.name];
    if (f.required && (v === undefined || v === "" || v === null)) problems.push(f.label + " is required.");
  }
  return problems;
}

function act(app, action) {
  const def = app.schema.collections[action.collection];
  if (action.type === "set") { setAt(app.data, action.path, action.value); return null; }
  if (!def) return "No such list.";

  if (action.type === "add") {
    const draft = getAt(app.data, "/draft/" + action.collection) || {};
    const problems = validate(def, draft);
    if (problems.length) return problems.join(" ");
    const rows = getAt(app.data, def.path) || [];
    const record = blank(def);
    for (const f of def.fields) if (draft[f.name] !== undefined) record[f.name] = draft[f.name];
    rows.push(record);
    setAt(app.data, def.path, rows);
    setAt(app.data, "/draft/" + action.collection, blank(def));
    return null;
  }
  if (action.type === "remove") {
    const rows = getAt(app.data, def.path) || [];
    rows.splice(action.index, 1);
    setAt(app.data, def.path, rows);
    return null;
  }
  if (action.type === "clearDraft") {
    setAt(app.data, "/draft/" + action.collection, blank(def));
    return null;
  }
  return null;
}

/* ---------------------------------------------------------------- render -- */

const el = (tag, attrs, kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of [].concat(kids || [])) {
    if (kid == null || kid === false) continue;
    node.appendChild(typeof kid === "string" || typeof kid === "number" ? document.createTextNode(String(kid)) : kid);
  }
  return node;
};

let APP = hydrate(load());
const firstCollection = Object.keys(APP.schema.collections)[0] || "";

function announce(msg) {
  const live = $("#bob-live");
  live.textContent = "";
  setTimeout(() => { live.textContent = msg; }, 60);
}

let PROBLEM = "";

function run(action) {
  const problem = act(APP, action);
  // An alert() blocks the page, loses the person's place, and reads terribly on
  // a phone. The message belongs next to the form it is about, and in the live
  // region so it is announced rather than only shown.
  PROBLEM = problem || "";
  if (problem) announce(problem);
  else save();
  draw();
}

function bindOf(node, prop) {
  const raw = (node.props || {})[prop];
  return raw && typeof raw === "object" && typeof raw.$bind === "string" ? raw.$bind : null;
}

function node(id, seen) {
  if (seen.has(id)) return null;
  seen.add(id);
  const n = APP.view.elements[id];
  if (!n) return null;
  const p = resolve(n.props, APP.data);
  const kids = () => (n.children || []).map((c) => node(c, seen)).filter(Boolean);

  switch (n.type) {
    case "Screen":  return el("main", {}, [el("h1", {}, p.title || APP.title), ...kids()]);
    case "Stack":   return el("div", { class: p.direction === "horizontal" ? "row" : "col" }, kids());
    case "Heading": return el("h2", {}, p.text);
    case "Text":    return el("p", {}, p.value);
    case "Status":  return el("p", { role: "status" }, p.message);
    case "List":    return el(p.ordered ? "ol" : "ul", {}, (p.items || []).map((i) => el("li", {}, i)));

    case "Metric":
      return el("div", { class: "metric", role: "group", "aria-label": p.label, "aria-live": "polite" },
        [el("b", {}, String(p.value) + (p.unit ? " " + p.unit : "")), el("span", {}, p.label)]);

    case "Table": {
      const rows = Array.isArray(p.rows) ? p.rows : [];
      const cols = p.columns || [];
      return el("div", { class: "card" }, [
        el("table", {}, [
          el("caption", {}, p.caption),
          el("thead", {}, el("tr", {}, [
            ...cols.map((c) => el("th", { scope: "col" }, c.label)),
            p.removable ? el("th", { scope: "col" }, "") : null,
          ])),
          el("tbody", {}, rows.length
            ? rows.map((row, i) => el("tr", {}, [
                ...cols.map((c) => el("td", {}, row[c.field] === true ? "yes" : row[c.field] === false ? "no" : String(row[c.field] ?? ""))),
                p.removable ? el("td", {}, el("button", {
                  class: "link",
                  type: "button",
                  onclick: () => run({ type: "remove", collection: p.collection || firstCollection, index: i }),
                }, "Delete")) : null,
              ]))
            : el("tr", {}, el("td", { colspan: cols.length + 1, class: "empty" }, "Nothing yet."))),
        ]),
      ]);
    }

    case "Field": {
      const path = bindOf(n, "value");
      return el("label", {}, [p.label, el("input", {
        type: p.kind === "number" ? "number" : p.kind === "date" ? "date" : p.kind === "url" ? "url" : "text",
        value: p.value ?? "",
        placeholder: p.placeholder || "",
        oninput: (e) => path && run({ type: "set", path, value: p.kind === "number" ? Number(e.target.value) : e.target.value }),
      })]);
    }

    case "Select": {
      const path = bindOf(n, "value");
      const sel = el("select", { onchange: (e) => path && run({ type: "set", path, value: e.target.value }) },
        [el("option", { value: "" }, "—"), ...(p.options || []).map((o) => el("option", { value: o }, o))]);
      sel.value = p.value ?? "";
      return el("label", {}, [p.label, sel]);
    }

    case "Checkbox": {
      const path = bindOf(n, "value");
      return el("label", { class: "inline" }, [
        el("input", { type: "checkbox", checked: !!p.value,
          onchange: (e) => path && run({ type: "set", path, value: e.target.checked }) }),
        p.label,
      ]);
    }

    case "Button":
      return el("button", {
        type: "button",
        class: p.variant === "primary" ? "primary" : "",
        onclick: () => run({ type: p.action, collection: p.collection || firstCollection }),
      }, p.label);

    default:
      return null;
  }
}

function draw() {
  const root = $("#bob-root");
  root.textContent = "";
  const tree = node(APP.view.root, new Set());
  if (tree) root.appendChild(tree);
  if (PROBLEM) {
    const box = el("p", { class: "problem", role: "alert" }, PROBLEM);
    (tree || root).appendChild(box);
  }
}

/* --------------------------------------------------------------- storage -- */

function load() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // The file is the source of truth for the interface; localStorage only
      // carries the data. A newer exported file therefore wins on layout while
      // keeping whatever was entered in the browser.
      if (parsed && parsed.data) return Object.assign({}, BOB_APP, { data: parsed.data });
    }
  } catch (_) {}
  return JSON.parse(JSON.stringify(BOB_APP));
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ data: APP.data })); }
  catch (_) { announce("Could not save. The browser is blocking storage."); }
}

function download() {
  const blob = new Blob([JSON.stringify(APP, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = APP.id + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
}

document.addEventListener("DOMContentLoaded", () => {
  draw();
  $("#bob-export").addEventListener("click", download);
});
`;

export interface ExportOptions {
  /** Namespace for localStorage, so two exports do not collide. */
  storageKey?: string;
}

export function exportHtml(app: AppFile, opts: ExportOptions = {}): string {
  const key = opts.storageKey ?? `bob:${app.id}`;
  const title = escapeHtml(app.title);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<div id="bob-root"></div>
<div id="bob-live" class="sr" role="status" aria-live="polite"></div>

<div class="bar">
  <button type="button" id="bob-export">Download your data</button>
  <span>Saved in this browser. Built once with Bob and running on its own since.</span>
</div>

<script>
const BOB_APP = ${embed(app)};
const KEY = ${embed(key)};
${RUNTIME}
</script>
</body>
</html>
`;
}
