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

import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
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
    throw new Error(`No app called ${JSON.stringify(id)} in ${workspaceDir(dir)}.`);
  }
  try {
    return parseApp(JSON.parse(text));
  } catch (err) {
    throw new Error(
      `${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
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

/**
 * Write atomically.
 *
 * A partial write here is somebody's records. Writing to a temporary file and
 * renaming means a crash mid-save leaves the previous version intact rather than
 * a truncated one, because rename is atomic on every platform that matters.
 */
export async function saveApp(app: AppFile, dir?: string): Promise<string> {
  const target = appPath(app.id, dir);
  await mkdir(workspaceDir(dir), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, serializeApp(app), "utf8");
  await rename(tmp, target);
  return target;
}

export interface AppSummary {
  id: string;
  title: string;
  updatedAt: string;
  records: number;
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
    try {
      const app = await loadApp(file.replace(/\.json$/, ""), dir);
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
      // A corrupt file should not hide the healthy ones from the list.
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
