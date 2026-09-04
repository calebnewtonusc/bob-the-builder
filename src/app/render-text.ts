/**
 * Render an app to text.
 *
 * This exists to make the central claim checkable rather than asserted: an app
 * runs with no model, no network, and no tokens, and produces the same output
 * every time. A terminal renderer is the smallest way to prove that, and it is
 * genuinely useful on its own.
 *
 * It is also the reference for what a renderer has to do. Anything that renders
 * a Bob app, in React or anywhere else, resolves bindings the same way, reads
 * the same schema, and dispatches the same actions.
 */

import type { Json } from "../core/spec.js";
import { resolveProps } from "../core/stream.js";
import { getAt } from "../core/pointer.js";
import type { AppFile } from "./format.js";
import { draftPath } from "./runtime.js";

const RESET = "\x1b[0m";
const dim = (s: string) => `\x1b[2m${s}${RESET}`;
const bold = (s: string) => `\x1b[1m${s}${RESET}`;
const cyan = (s: string) => `\x1b[36m${s}${RESET}`;

export interface RenderOptions {
  /** Strip ANSI colour, for snapshots and pipes. */
  plain?: boolean;
  width?: number;
}

function cellText(value: Json | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function table(
  columns: { field: string; label: string }[],
  rows: Record<string, Json>[],
  paint: (s: string) => string,
  removable: boolean,
): string[] {
  const headers = removable ? ["#", ...columns.map((c) => c.label)] : columns.map((c) => c.label);
  const body = rows.map((row, i) => {
    const cells = columns.map((c) => cellText(row[c.field]));
    return removable ? [String(i), ...cells] : cells;
  });

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((r) => (r[i] ?? "").length), 3),
  );

  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();

  const out = [paint(line(headers)), dim(widths.map((w) => "─".repeat(w)).join("  "))];
  if (body.length === 0) {
    out.push(dim("  (nothing yet)"));
  } else {
    for (const row of body) out.push(line(row));
  }
  return out;
}

export function renderApp(app: AppFile, opts: RenderOptions = {}): string {
  const plain = opts.plain ?? false;
  const B = plain ? (s: string) => s : bold;
  const D = plain ? (s: string) => s : dim;
  const C = plain ? (s: string) => s : cyan;

  const lines: string[] = [];
  const actions: string[] = [];
  const seen = new Set<string>();

  const walk = (id: string, indent: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = app.view.elements[id];
    if (!node || node.type === "__pending__") return;

    const p = resolveProps(node.props, app.data);
    const pad = "  ".repeat(indent);

    switch (node.type) {
      case "Screen":
        lines.push(B(String(p["title"] ?? app.title)));
        lines.push("");
        break;

      case "Heading": {
        const level = Number(p["level"] ?? 2);
        lines.push("");
        lines.push(pad + (level === 1 ? B(String(p["text"])) : B(String(p["text"]))));
        break;
      }

      case "Text":
        lines.push(pad + D(String(p["value"] ?? "")));
        break;

      case "Metric": {
        const unit = p["unit"] ? ` ${String(p["unit"])}` : "";
        lines.push(`${pad}${B(String(p["value"]))}${unit}  ${D(String(p["label"]))}`);
        break;
      }

      case "List": {
        const items = Array.isArray(p["items"]) ? (p["items"] as Json[]) : [];
        items.forEach((item, i) => {
          const marker = p["ordered"] ? `${i + 1}.` : "·";
          lines.push(`${pad}${D(marker)} ${cellText(item)}`);
        });
        break;
      }

      case "Table": {
        const rows = Array.isArray(p["rows"]) ? (p["rows"] as Record<string, Json>[]) : [];
        const columns = Array.isArray(p["columns"])
          ? (p["columns"] as { field: string; label: string }[])
          : [];
        lines.push("");
        lines.push(pad + B(String(p["caption"] ?? "")));
        for (const row of table(columns, rows, B, Boolean(p["removable"]))) {
          lines.push(pad + row);
        }
        if (p["removable"] && rows.length > 0) {
          actions.push(`bob rm ${app.id} <#>`);
        }
        break;
      }

      case "Field":
      case "Select":
      case "Checkbox": {
        const raw = node.props["value"];
        const bound =
          typeof raw === "object" && raw !== null && "$bind" in raw && typeof raw.$bind === "string"
            ? raw.$bind
            : null;
        const field = bound ? (bound.split("/").pop() ?? "") : "";
        const value = cellText(p["value"] as Json);
        const options =
          node.type === "Select" && Array.isArray(p["options"])
            ? D(`  [${(p["options"] as Json[]).map(cellText).join(" / ")}]`)
            : "";
        lines.push(
          `${pad}${D(String(p["label"]) + ":")} ${value || D("—")}${options}`,
        );
        if (field) actions.push(`bob set ${app.id} ${field} <value>`);
        break;
      }

      case "Button": {
        const action = String(p["action"]);
        const collection = p["collection"] ? ` ${String(p["collection"])}` : "";
        lines.push(`${pad}${C("[ " + String(p["label"]) + " ]")}`);
        if (action === "add") actions.push(`bob add ${app.id}`);
        else if (action === "clearDraft") actions.push(`bob clear ${app.id}${collection}`);
        break;
      }

      case "Status":
        lines.push(pad + C(String(p["message"])));
        break;

      default:
        break;
    }

    const nested = node.type === "Screen" || node.type === "Stack";
    for (const child of node.children) walk(child, nested ? indent : indent + 1);
  };

  if (app.view.root) walk(app.view.root, 0);

  if (actions.length > 0) {
    lines.push("");
    lines.push(D("─".repeat(40)));
    for (const a of [...new Set(actions)]) lines.push(D("  " + a));
  }

  return lines.join("\n");
}

/** The draft a form is currently holding, for showing what would be added. */
export function draftOf(app: AppFile, collection: string): Record<string, Json> {
  const draft = getAt(app.data, draftPath(collection));
  return typeof draft === "object" && draft !== null && !Array.isArray(draft)
    ? (draft as Record<string, Json>)
    : {};
}
