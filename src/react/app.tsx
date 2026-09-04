/**
 * Rendering an app file in React.
 *
 * This is the bridge that was missing: the terminal renderer proved an app runs
 * without a model, and this is the same thing on a screen. It renders the app's
 * stored view, resolves bindings and counts against the app's data, and turns
 * every interaction into one of the runtime's deterministic actions.
 *
 * No model is involved at any point here, and there is no streaming. The view
 * was authored once and is read from a file, so this component is a pure
 * function of an app file. That is the property the whole project exists for,
 * and it is why this file is short.
 */

import { useCallback, useMemo, type ReactNode } from "react";
import type { Json } from "../core/spec.js";
import type { AppFile } from "../app/format.js";
import { applyAction, type AppAction } from "../app/runtime.js";
import { appCatalog } from "../app/catalog.js";
import { BobSurface, type ComponentMap } from "./surface.js";
import { useAnnouncer } from "./live-region.js";

export interface BobAppProps {
  app: AppFile;
  /**
   * Called with the updated app whenever an action changes it. Persisting is
   * the caller's job: in the CLI that is a file write, on the web it might be
   * IndexedDB or a sync engine. The runtime does not care.
   */
  onChange: (app: AppFile) => void;
  /** Your components. Falls back to unstyled ones so it renders out of the box. */
  components?: Record<string, ComponentMap[string]>;
  /** Shown when an action is refused, e.g. a required field left blank. */
  onMessage?: (message: string) => void;
}

/**
 * Map a component's action back onto the runtime.
 *
 * The catalog declares four actions and the runtime implements exactly those,
 * so this is a translation rather than a decision. A component cannot invent an
 * action, and an action cannot do anything the schema does not describe.
 */
function toRuntimeAction(
  name: string,
  payload: Record<string, Json> | undefined,
  fallbackCollection: string,
): AppAction | null {
  const collection = String(payload?.["collection"] ?? fallbackCollection);
  switch (name) {
    case "add":
      return { type: "add", collection };
    case "clearDraft":
      return { type: "clearDraft", collection };
    case "remove":
      return { type: "remove", collection, index: Number(payload?.["index"] ?? -1) };
    case "update":
      return {
        type: "update",
        collection,
        index: Number(payload?.["index"] ?? -1),
        field: String(payload?.["field"] ?? ""),
        value: (payload?.["value"] ?? null) as Json,
      };
    default:
      return null;
  }
}

export function BobApp({ app, onChange, components, onMessage }: BobAppProps) {
  const { announce } = useAnnouncer();

  const firstCollection = useMemo(
    () => Object.keys(app.schema.collections)[0] ?? "",
    [app.schema.collections],
  );

  const run = useCallback(
    (action: AppAction) => {
      const result = applyAction(app, action);
      if (!result.changed) {
        if (result.message) {
          onMessage?.(result.message);
          // Validation failures are exactly what a live region is for: the
          // person pressed a button and nothing visible happened.
          announce(result.message, "assertive");
        }
        return;
      }
      onChange(result.app);
    },
    [app, onChange, onMessage, announce],
  );

  const handleAction = useCallback(
    (name: string, payload?: Record<string, Json>) => {
      const action = toRuntimeAction(name, payload, firstCollection);
      if (action) run(action);
    },
    [firstCollection, run],
  );

  // The app's view is a normal spec, so the streaming renderer draws it. The
  // only difference is that nothing is streaming: `ready` is always true because
  // the view arrived complete, from a file.
  const handleWrite = useCallback(
    (pointer: string, value: Json) => run({ type: "set", path: pointer, value }),
    [run],
  );

  return (
    <BobSurface
      spec={{ ...app.view, data: app.data }}
      catalog={appCatalog}
      components={{ ...defaultComponents, ...components }}
      ready
      onAction={handleAction}
      onWrite={handleWrite}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Unstyled defaults                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately unstyled, and using real semantic elements.
 *
 * These exist so an app renders correctly the moment you import it, and so the
 * accessibility the catalog promises is actually delivered by something rather
 * than only declared. Replace any of them with your own design system; the
 * contract is the props the catalog declares and the role it says it renders.
 */
const defaultComponents: Record<string, ComponentMap[string]> = {
  Screen: ({ title, children }) => (
    <main aria-label={String(title)}>
      <h1>{String(title)}</h1>
      {children as ReactNode}
    </main>
  ),

  Stack: ({ direction, gap, children }) => (
    <div
      role="group"
      style={{
        display: "flex",
        flexDirection: direction === "horizontal" ? "row" : "column",
        gap: `${Number(gap ?? 2) * 4}px`,
      }}
    >
      {children as ReactNode}
    </div>
  ),

  Heading: ({ text, level }) => {
    const Tag = (`h${Math.min(6, Number(level ?? 2) + 1)}` as unknown) as "h2";
    return <Tag>{String(text)}</Tag>;
  },

  Text: ({ value, tone }) => (
    <p style={tone === "muted" ? { opacity: 0.7 } : undefined}>{String(value ?? "")}</p>
  ),

  Metric: ({ label, value, unit }) => (
    <div role="group" aria-label={String(label)} aria-live="polite">
      <strong>{String(value)}</strong>
      {unit ? ` ${String(unit)}` : null}
      <div>{String(label)}</div>
    </div>
  ),

  List: ({ items, ordered }) => {
    const Tag = ordered ? "ol" : "ul";
    const list = Array.isArray(items) ? (items as Json[]) : [];
    return (
      <Tag>
        {list.map((item, i) => (
          <li key={i}>{String(item)}</li>
        ))}
      </Tag>
    );
  },

  Table: ({ caption, rows, columns, collection, removable, onAction }) => {
    const list = Array.isArray(rows) ? (rows as Record<string, Json>[]) : [];
    const cols = Array.isArray(columns)
      ? (columns as { field: string; label: string }[])
      : [];
    return (
      <table>
        <caption>{String(caption)}</caption>
        <thead>
          <tr>
            {cols.map((col) => (
              <th key={col.field} scope="col">
                {col.label}
              </th>
            ))}
            {removable ? <th scope="col">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {list.map((row, i) => (
            <tr key={i}>
              {cols.map((col) => (
                <td key={col.field}>{String(row[col.field] ?? "")}</td>
              ))}
              {removable ? (
                <td>
                  <button
                    type="button"
                    onClick={() =>
                      onAction("remove", { collection: String(collection), index: i })
                    }
                  >
                    {/* Named per row, so a screen reader hears which one. */}
                    Delete row {i + 1}
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    );
  },

  Field: ({ label, value, kind, placeholder, onChange }) => (
    <label>
      {String(label)}
      <input
        type={kind === "longtext" ? "text" : String(kind ?? "text")}
        value={String(value ?? "")}
        placeholder={placeholder ? String(placeholder) : undefined}
        onChange={(e) =>
          onChange("value", kind === "number" ? Number(e.target.value) : e.target.value)
        }
      />
    </label>
  ),

  Select: ({ label, value, options, onChange }) => (
    <label>
      {String(label)}
      <select value={String(value ?? "")} onChange={(e) => onChange("value", e.target.value)}>
        <option value="">—</option>
        {(Array.isArray(options) ? (options as Json[]) : []).map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </select>
    </label>
  ),

  Checkbox: ({ label, value, onChange }) => (
    <label>
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange("value", e.target.checked)}
      />
      {String(label)}
    </label>
  ),

  Button: ({ label, action, collection, onAction }) => (
    <button
      type="button"
      onClick={() =>
        onAction(String(action), collection ? { collection: String(collection) } : undefined)
      }
    >
      {String(label)}
    </button>
  ),

  Status: ({ message, level }) => (
    <div role="status" aria-live="polite" data-level={String(level)}>
      {String(message)}
    </div>
  ),
};

export { defaultComponents as bobDefaultComponents };
