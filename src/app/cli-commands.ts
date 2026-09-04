/**
 * The commands people actually live in.
 *
 * Note which of these touch a model: `make` and `change`, and nothing else.
 * Opening an app, adding a record, editing a value, deleting a row, reading the
 * history: all of it is local, instant, and free. That is the point of the whole
 * project, so it is worth being able to see it in one file.
 */

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Json } from "../core/spec.js";
import type { ModelAdapter } from "../eval/adapter.js";
import { defineAdapter } from "../eval/adapter.js";
import { appCatalog } from "./catalog.js";
import { authorApp, editApp } from "./author.js";
import type { AppFile, FieldDef } from "./format.js";
import { applyAction, draftPath, hydrate } from "./runtime.js";
import { renderApp } from "./render-text.js";
import { exportHtml } from "./export-html.js";
import { HudConnection, hudIsRunning, hudSocketPath } from "./hud.js";
import { buildSystemPrompt } from "../core/prompt.js";
import { writeFile } from "node:fs/promises";
import {
  appExists,
  appPath,
  availableId,
  listApps,
  loadApp,
  saveApp,
  workspaceDir,
} from "./store.js";
import { getAt } from "../core/pointer.js";

const RESET = "\x1b[0m";
const c = {
  dim: (s: string) => `\x1b[2m${s}${RESET}`,
  bold: (s: string) => `\x1b[1m${s}${RESET}`,
  red: (s: string) => `\x1b[31m${s}${RESET}`,
  green: (s: string) => `\x1b[32m${s}${RESET}`,
  yellow: (s: string) => `\x1b[33m${s}${RESET}`,
};

export class CommandError extends Error {}

/* -------------------------------------------------------------------------- */
/* Getting a model                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a model, in the least demanding way that works.
 *
 * `BOB_MODEL_CMD` is a command that reads a prompt on stdin and writes the
 * answer to stdout. That covers the `claude` and `llm` CLIs, an ollama wrapper,
 * or a three-line shell script, without this project shipping an SDK, holding an
 * API key, or caring which provider you use.
 */
export async function resolveAdapter(explicit?: string): Promise<ModelAdapter> {
  if (explicit) {
    const mod = (await import(pathToFileURL(resolve(explicit)).href)) as Record<string, unknown>;
    const adapter = (mod["adapter"] ?? mod["default"]) as ModelAdapter | undefined;
    if (!adapter || typeof adapter.stream !== "function") {
      throw new CommandError(`${explicit} does not export a model adapter.`);
    }
    return adapter;
  }

  const cmd = process.env["BOB_MODEL_CMD"];
  if (!cmd) {
    throw new CommandError(
      "No model configured.\n\n" +
        "  export BOB_MODEL_CMD='claude -p'\n\n" +
        "Any command that reads a prompt on stdin and writes the answer to stdout\n" +
        "works. Only `make` and `change` need it: everything else runs offline.",
    );
  }

  return defineAdapter(cmd.split(/\s+/)[0]!, async function* (system, user) {
    const [bin, ...args] = cmd.split(/\s+/);
    const child = spawn(bin!, args, { stdio: ["pipe", "pipe", "inherit"] });

    // A typo in BOB_MODEL_CMD is the likeliest setup mistake there is, and it
    // used to surface as a Node stack trace about a failed spawn.
    const failed = new Promise<never>((_, reject) => {
      child.on("error", (err: NodeJS.ErrnoException) => {
        reject(
          new CommandError(
            err.code === "ENOENT"
              ? `Could not run ${JSON.stringify(bin)}, because there is no such command.\n` +
                `BOB_MODEL_CMD is currently ${JSON.stringify(cmd)}.\n` +
                `Try: export BOB_MODEL_CMD='claude -p'`
              : `Could not run ${JSON.stringify(bin)}: ${err.message}`,
          ),
        );
      });
    });

    child.stdin.on("error", () => {
      // The process died before it could read the prompt. The error handler
      // above already has the real reason; swallowing this avoids an EPIPE
      // crash masking it.
    });
    child.stdin.write(`${system}\n\n---\n\n${user}\n`);
    child.stdin.end();

    const chunks: string[] = [];
    const read = (async () => {
      for await (const chunk of child.stdout) chunks.push(String(chunk));
      return new Promise<number>((res) => child.on("close", (x) => res(x ?? 0)));
    })();

    const code = await Promise.race([read, failed]);
    if (code !== 0) {
      throw new CommandError(
        `${bin} exited with code ${code} without producing an app.`,
      );
    }
    if (chunks.join("").trim() === "") {
      throw new CommandError(`${bin} produced no output.`);
    }

    // Models wrap answers in fences even when told not to. Strip rather than fail.
    yield chunks.join("").replace(/^\s*```[a-z]*\n?/i, "").replace(/```\s*$/, "");
  });
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

export async function cmdMake(
  request: string,
  opts: { dir?: string; adapter?: string; force?: boolean } = {},
): Promise<void> {
  const adapter = await resolveAdapter(opts.adapter);
  process.stderr.write(c.dim("  building…\n"));

  const authored = await authorApp(adapter, request, appCatalog);
  const { warnings } = authored;
  let app = authored.app;

  // Building an app whose title matches an existing one used to overwrite it,
  // records and all. That is the single thing this project promises cannot
  // happen, so it is now impossible without saying so explicitly.
  if (!opts.force && (await appExists(app.id, opts.dir))) {
    const free = await availableId(app.id, opts.dir);
    console.log(
      c.yellow(
        `\n  There is already an app called ${app.id}. ` +
          `Building this one as ${c.bold(free)} instead.\n` +
          `  Use --force to replace the existing app and lose its records.`,
      ),
    );
    app = { ...app, id: free };
  }

  const path = await saveApp(app, opts.dir);

  console.log("\n" + renderApp(app));
  console.log("");
  console.log(c.green(`  Built ${c.bold(app.title)}`));
  console.log(c.dim(`  ${path}`));
  console.log(
    c.dim(`  It is yours now. Opening it costs nothing: bob open ${app.id}`),
  );
  for (const w of warnings) console.log(c.yellow(`  note: ${w}`));
}

export function cmdOpen(app: AppFile): void {
  console.log("\n" + renderApp(app));
}

export async function cmdSet(
  id: string,
  field: string,
  value: string,
  opts: { dir?: string; in?: string } = {},
): Promise<void> {
  const app = hydrate(await loadApp(id, opts.dir));
  const [collection, def] = pickCollection(app, opts.in);

  const fieldDef = def.fields.find((f) => f.name === field);
  if (!fieldDef) {
    throw new CommandError(
      `${def.noun} has no field called ${field}.\n` +
        `Fields: ${def.fields.map((f) => f.name).join(", ")}`,
    );
  }

  const result = applyAction(app, {
    type: "set",
    path: `${draftPath(collection)}/${field}`,
    value: coerce(value, fieldDef),
  });
  if (!result.changed) throw new CommandError(result.message ?? "Nothing changed.");

  await saveApp(result.app, opts.dir);
  console.log("\n" + renderApp(result.app));
}

export async function cmdAdd(
  id: string,
  opts: { dir?: string; in?: string } = {},
): Promise<void> {
  const app = hydrate(await loadApp(id, opts.dir));
  const [collection, def] = pickCollection(app, opts.in);

  const result = applyAction(app, { type: "add", collection });
  if (!result.changed) {
    // Validation lives in the runtime, so this message is the same forever
    // rather than depending on what a model remembered this time.
    throw new CommandError(result.message ?? "Nothing was added.");
  }

  await saveApp(result.app, opts.dir);
  console.log("\n" + renderApp(result.app));
  console.log("\n" + c.green(`  Saved the ${def.noun}.`));
}

export async function cmdRemove(
  id: string,
  index: number,
  opts: { dir?: string; in?: string } = {},
): Promise<void> {
  const app = hydrate(await loadApp(id, opts.dir));
  const [collection] = pickCollection(app, opts.in);

  const result = applyAction(app, { type: "remove", collection, index });
  if (!result.changed) throw new CommandError(result.message ?? "Nothing was removed.");

  await saveApp(result.app, opts.dir);
  console.log("\n" + renderApp(result.app));
}

export async function cmdClear(
  id: string,
  opts: { dir?: string; in?: string } = {},
): Promise<void> {
  const app = hydrate(await loadApp(id, opts.dir));
  const [collection] = pickCollection(app, opts.in);
  const result = applyAction(app, { type: "clearDraft", collection });
  await saveApp(result.app, opts.dir);
  console.log("\n" + renderApp(result.app));
}

export async function cmdChange(
  id: string,
  request: string,
  opts: { dir?: string; adapter?: string } = {},
): Promise<void> {
  const app = await loadApp(id, opts.dir);
  const adapter = await resolveAdapter(opts.adapter);
  process.stderr.write(c.dim("  changing…\n"));

  const before = countRecords(app);
  const { app: next, ops, summary, addedFields, warnings } = await editApp(
    adapter,
    app,
    request,
    appCatalog,
  );

  // The data guarantee is worth checking rather than trusting, because it is the
  // reason a person can ask for a change without bracing for loss.
  if (countRecords(next) !== before) {
    throw new CommandError(
      `An edit changed the number of records from ${before} to ${countRecords(next)}. ` +
        `That should be impossible. Nothing was saved.`,
    );
  }

  await saveApp(next, opts.dir);
  console.log("\n" + renderApp(next));
  console.log("");
  console.log(c.green(`  ${summary}`));
  console.log(c.dim(`  ${ops.length} change(s), ${before} record(s) untouched`));
  if (addedFields.length > 0) {
    console.log(c.dim(`  added to the schema: ${addedFields.join(", ")}`));
  }
  console.log(c.dim(`  bob log ${id} to see every change to this app`));
  for (const w of warnings) console.log(c.yellow(`  note: ${w}`));
}

export async function cmdList(opts: { dir?: string } = {}): Promise<void> {
  const apps = await listApps(opts.dir);
  if (apps.length === 0) {
    console.log(
      `\n  ${c.dim("No apps yet.")}\n\n  ${c.bold('bob make "a tracker for my job applications"')}\n`,
    );
    return;
  }
  console.log("");
  for (const app of apps) {
    if (app.damaged) {
      console.log(
        `  ${c.bold(app.id.padEnd(24))} ${c.red("(damaged)")}\n` +
          `  ${c.dim(" ".repeat(24) + ` the file will not parse. bob open ${app.id} says why.`)}`,
      );
      continue;
    }
    const when = app.updatedAt.slice(0, 10);
    console.log(
      `  ${c.bold(app.id.padEnd(24))} ${app.title}\n` +
        `  ${c.dim(" ".repeat(24) + ` ${app.records} record(s), updated ${when}`)}`,
    );
  }
  console.log(c.dim(`\n  ${workspaceDir(opts.dir)}\n`));
}

export async function cmdLog(id: string, opts: { dir?: string } = {}): Promise<void> {
  const app = await loadApp(id, opts.dir);
  console.log(`\n  ${c.bold(app.title)} ${c.dim(appPath(app.id, opts.dir))}\n`);
  if (app.history.length === 0) {
    console.log(c.dim("  No changes recorded.\n"));
    return;
  }
  app.history.forEach((entry, i) => {
    console.log(`  ${c.bold(`#${i + 1}`)} ${entry.summary}`);
    console.log(c.dim(`      "${entry.request}"`));
    console.log(
      c.dim(`      ${entry.at.slice(0, 16).replace("T", " ")} · ${entry.by} · ${entry.ops.length} op(s)`),
    );
  });
  console.log("");
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pick the collection a command should act on.
 *
 * Most apps have exactly one, so naming it every time would be noise. An app
 * with several is ambiguous, and guessing the first one silently writes to the
 * wrong list, so that case asks.
 */
function pickCollection(
  app: AppFile,
  requested?: string,
): [string, AppFile["schema"]["collections"][string]] {
  const entries = Object.entries(app.schema.collections);
  if (entries.length === 0) {
    throw new CommandError(`${app.title} has no collections to write to.`);
  }

  if (requested) {
    const found = app.schema.collections[requested];
    if (!found) {
      throw new CommandError(
        `${app.title} has no collection called ${requested}.\n` +
          `It has: ${entries.map(([n]) => n).join(", ")}`,
      );
    }
    return [requested, found];
  }

  if (entries.length > 1) {
    throw new CommandError(
      `${app.title} has more than one list, so say which one:\n` +
        entries.map(([n, d]) => `  --in ${n}   (${d.noun}s)`).join("\n"),
    );
  }
  return entries[0]!;
}

function countRecords(app: AppFile): number {
  let n = 0;
  for (const def of Object.values(app.schema.collections)) {
    const rows = getAt(app.data, def.path);
    if (Array.isArray(rows)) n += rows.length;
  }
  return n;
}

/** Turn a command-line string into the type the schema says the field holds. */
function coerce(value: string, field: FieldDef): Json {
  switch (field.type) {
    case "number": {
      const n = Number(value);
      if (Number.isNaN(n)) {
        throw new CommandError(`${field.label} is a number, and ${JSON.stringify(value)} is not.`);
      }
      return n;
    }
    case "checkbox":
      return ["true", "yes", "y", "1", "on"].includes(value.toLowerCase());
    case "select": {
      if (field.options && !field.options.includes(value)) {
        throw new CommandError(
          `${field.label} must be one of: ${field.options.join(", ")}`,
        );
      }
      return value;
    }
    default:
      return value;
  }
}


/**
 * Write the app as one self-contained HTML file.
 *
 * The last gap between this and something you can hand to somebody: a terminal
 * renderer and a React component both serve people who already have a
 * development environment. An HTML file opens by double-clicking, works offline,
 * works on a phone, and can be emailed.
 */
export async function cmdShare(
  id: string,
  target: string | undefined,
  opts: { dir?: string } = {},
): Promise<void> {
  const app = hydrate(await loadApp(id, opts.dir));
  const out = resolve(target ?? `${app.id}.html`);
  await writeFile(out, exportHtml(app), "utf8");

  const records = countRecords(app);
  console.log("");
  console.log(c.green(`  Wrote ${c.bold(out)}`));
  console.log(
    c.dim(
      `  ${records} record(s) included. Open it in any browser, or send it to someone.\n` +
        `  It works offline and needs nothing installed. Changes made in the page\n` +
        `  save to that browser; "Download your data" gets them back as JSON.`,
    ),
  );
}


/**
 * Draw something on the floating panel.
 *
 * With a request, a model writes Bob Lines and they go straight to the socket,
 * so the panel assembles at the rate the model writes rather than appearing all
 * at once when it finishes. With a file, the file is piped in.
 *
 * Nothing is persisted: a HUD surface is a glance, not an app. Use `bob make`
 * when the thing should still be there tomorrow.
 */
export async function cmdHud(
  input: string,
  opts: { adapter?: string; file?: boolean } = {},
): Promise<void> {
  if (!(await hudIsRunning())) {
    throw new CommandError(
      `Nothing is listening on ${hudSocketPath()}.\n` +
        `Start the panel first, then try again.`,
    );
  }

  const connection = await HudConnection.open();

  if (opts.file) {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(resolve(input), "utf8");
    connection.write(text.endsWith("\n") ? text : text + "\n");
    connection.close();
    console.log(c.dim("  drawn"));
    return;
  }

  const adapter = await resolveAdapter(opts.adapter);
  const system =
    buildSystemPrompt(appCatalog, { format: "lines" }) +
    `\n\n## This is a heads-up display\n\n` +
    `It floats over whatever the person is doing and is glanced at, not used. So:\n` +
    `no forms, no inputs, no buttons. Lead with the two or three numbers that\n` +
    `answer the question, then the detail. Keep it under fifteen components: this\n` +
    `is a panel in the corner of a screen, not a page.`;

  process.stderr.write(c.dim("  drawing…\n"));
  await connection.pipe(adapter.stream(system, input));
  console.log(c.dim("  drawn"));
}
