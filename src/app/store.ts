/**
 * Where apps live on disk.
 *
 * A workspace is a directory of JSON files and nothing else. No database, no
 * account, no sync service, no server that has to stay up for your tracker to
 * open. This is deliberate and it is the same property that makes a text file
 * outlast the editor that wrote it: an app you cannot lose is worth more than an
 * app with better features.
 *
 * The file is readable, diffable, and greppable. If this project is abandoned
 * tomorrow, the data is still yours and still legible.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseApp, serializeApp, type AppFile } from "./format.js";

export function workspaceDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env["BOB_WORKSPACE"]) return resolve(process.env["BOB_WORKSPACE"]);
  return join(homedir(), ".bob", "apps");
}

export function appPath(id: string, dir?: string): string {
  return join(workspaceDir(dir), `${id}.json`);
}

export async function loadApp(id: string, dir?: string): Promise<AppFile> {
  const path = appPath(id, dir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new AppError(
      `No app called ${JSON.stringify(id)} in ${workspaceDir(dir)}.\n` +
        `Run \`bob list\` to see what is there.`,
    );
  }
  try {
    return parseApp(JSON.parse(text));
  } catch (err) {
    throw new AppError(
      `${path} is damaged and could not be read.\n` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `The file is plain JSON, so it can be opened and repaired in any editor.`,
    );
  }
}

/**
 * A problem a person can act on, phrased as a sentence.
 *
 * Everything in this file touches the filesystem, and the filesystem fails in
 * ways that are perfectly normal: a folder is read-only, a disk is full, a file
 * got edited by hand and no longer parses. Those reached the user as raw Node
 * stack traces, which for a tool aimed at people who do not write software is
 * the same as no message at all.
 */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}

/** Turn a Node filesystem error into something worth reading. */
function describeFsError(err: unknown, path: string, doing: string): AppError {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return new AppError(
        `No permission to ${doing} ${path}.\n` +
          `Check the folder's permissions, or set BOB_WORKSPACE to somewhere you can write.`,
      );
    case "ENOSPC":
      return new AppError(`The disk is full, so ${path} could not be written.`);
    case "EROFS":
      return new AppError(`${path} is on a read-only filesystem.`);
    case "ENOENT":
      return new AppError(`${path} does not exist.`);
    default:
      return new AppError(
        `Could not ${doing} ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
  }
}

export class AppExistsError extends Error {
  constructor(readonly id: string, readonly path: string) {
    super(
      `An app called ${JSON.stringify(id)} already exists at ${path}.\n` +
        `Building over it would destroy its records. Give the new one a ` +
        `different name, or pass --force if you really mean to replace it.`,
    );
    this.name = "AppExistsError";
  }
}

export async function appExists(id: string, dir?: string): Promise<boolean> {
  try {
    await readFile(appPath(id, dir), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * A free id near the one you wanted.
 *
 * Two apps can reasonably have similar names, and the alternative to suffixing
 * is refusing to build. `job-applications-2` is a worse name than
 * `job-applications` and an infinitely better outcome than silently deleting
 * somebody's year of records.
 */
export async function availableId(preferred: string, dir?: string): Promise<string> {
  if (!(await appExists(preferred, dir))) return preferred;
  for (let n = 2; n < 100; n++) {
    const candidate = `${preferred}-${n}`;
    if (!(await appExists(candidate, dir))) return candidate;
  }
  throw new Error(`Could not find a free name near ${preferred}.`);
}

export class AppLockedError extends Error {
  constructor(readonly id: string) {
    super(
      `${id} is being changed by another process. Wait a moment and try again.\n` +
        `If nothing else is running, delete the stale lock and retry.`,
    );
    this.name = "AppLockedError";
  }
}

/** How long a lock may be held before it is assumed to be from a dead process. */
const LOCK_STALE_MS = 30_000;

/**
 * Take an exclusive lock on one app.
 *
 * Every command here is read-modify-write, so two processes editing the same app
 * at once will lose one of the edits: both read the same file, both write their
 * own version, and the second overwrites the first. That is easy to hit by
 * accident with a shell loop, and losing a record you just typed is exactly the
 * failure this project cannot afford.
 *
 * `wx` fails if the file exists, which is the atomic test-and-set. A lock older
 * than the timeout is assumed to belong to a process that died and is taken over,
 * because a crashed command should not permanently brick an app.
 */
async function withLock<T>(id: string, dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(dir, `${id}.lock`);

  try {
    await writeFile(lock, String(process.pid), { flag: "wx" });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code && code !== "EEXIST") throw describeFsError(err, dir, "write to");

    let stale = false;
    try {
      const info = await stat(lock);
      stale = Date.now() - info.mtimeMs > LOCK_STALE_MS;
    } catch {
      stale = true; // Vanished between the failed write and the stat.
    }
    if (!stale) throw new AppLockedError(id);
    await writeFile(lock, String(process.pid));
  }

  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/**
 * Write atomically, under a lock.
 *
 * A partial write here is somebody's records. Writing to a temporary file and
 * renaming means a crash mid-save leaves the previous version intact rather than
 * a truncated one, because rename is atomic on every platform that matters.
 */
export async function saveApp(app: AppFile, dir?: string): Promise<string> {
  const folder = workspaceDir(dir);
  const target = appPath(app.id, dir);
  try {
    await mkdir(folder, { recursive: true });
  } catch (err) {
    throw describeFsError(err, folder, "create");
  }

  return withLock(app.id, folder, async () => {
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, serializeApp(app), "utf8");
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw describeFsError(err, target, "write");
    }
    return target;
  });
}

export interface AppSummary {
  id: string;
  title: string;
  updatedAt: string;
  records: number;
  /** The file exists but will not parse. Listed so it is not thought lost. */
  damaged?: boolean;
}

export async function listApps(dir?: string): Promise<AppSummary[]> {
  let files: string[];
  try {
    files = await readdir(workspaceDir(dir));
  } catch {
    return [];
  }

  const out: AppSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    if (file.endsWith(".tmp") || file.endsWith(".lock")) continue;
    const id = file.replace(/\.json$/, "");
    try {
      const app = await loadApp(id, dir);
      let records = 0;
      for (const def of Object.values(app.schema.collections)) {
        const rows = def.path
          .replace(/^\//, "")
          .split("/")
          .reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], app.data);
        if (Array.isArray(rows)) records += rows.length;
      }
      out.push({
        id: app.id,
        title: app.title,
        updatedAt: app.updatedAt,
        records,
      });
    } catch {
      // A damaged file is still someone's app. Hiding it from the list means
      // they think it was deleted, which is worse than any error message.
      out.push({ id, title: "(damaged)", updatedAt: "", records: 0, damaged: true });
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
