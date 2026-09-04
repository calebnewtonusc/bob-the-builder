/**
 * Bob Lines: the compact wire format.
 *
 * Why a second format exists at all. JSON pays for a key, two quotes, a colon
 * and a comma on every single field, and the model pays that tax in tokens
 * before the user sees anything. Published benchmarks put a line-oriented format
 * at roughly half the tokens of the JSON encoding of the same interface, which
 * on a slow model is the difference between a five second render and a fifteen
 * second one. That benchmark was run by a vendor whose own format won it, so
 * `bob audit tokens` measures the spread on *your* catalog rather than asking
 * you to take anyone's word for it.
 *
 * The second reason is better than the first and nobody advertises it: this
 * format is safe to stream by construction. A line is either complete or it is
 * not, so "never render a half-arrived value" is enforced by `\n` instead of by
 * a partial-JSON parser that has to guess whether a string is finished. There is
 * no state to get wrong.
 *
 *   c <id> <Type> [key=value ...]     declare or update a component
 *   > <id> <child> [child ...]        set a component's children
 *   d <pointer> <json>                patch the data model
 *   r <id>                            declare the root
 *   # anything                        comment, ignored
 *
 * Values: JSON scalars, inline JSON objects and arrays, `@/pointer` for a data
 * binding, and `!action` for an action reference.
 */

import type { Json, Op, PropValue, ComponentNode } from "./spec.js";
import { isBinding } from "./spec.js";

export class LineParseError extends Error {
  constructor(
    message: string,
    readonly line: string,
    readonly lineNumber: number,
  ) {
    super(`${message} (line ${lineNumber}: ${JSON.stringify(line)})`);
    this.name = "LineParseError";
  }
}

/**
 * Split a line into whitespace-separated tokens, keeping quoted strings and
 * bracketed JSON intact. Written by hand because `split` cannot see quoting and
 * a regex that can is worse to read than the loop.
 */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    while (i < n && (line[i] === " " || line[i] === "\t")) i++;
    if (i >= n) break;

    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;

    while (i < n) {
      const ch = line[i]!;

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
      } else if ((ch === " " || ch === "\t") && depth === 0) {
        break;
      }
      i++;
    }

    if (inString || depth !== 0) {
      // Unbalanced: hand back the rest of the line as one token and let the
      // caller produce a useful error rather than silently truncating.
      out.push(line.slice(start));
      return out;
    }
    out.push(line.slice(start, i));
  }

  return out;
}

function parseValue(raw: string): PropValue {
  if (raw.startsWith("@")) return { $bind: raw.slice(1) };
  if (raw.startsWith("!")) return raw.slice(1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;

  const first = raw[0];
  if (first === '"' || first === "{" || first === "[") {
    return JSON.parse(raw) as Json;
  }
  if (/^-?\d/.test(raw)) {
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
  }
  // A bare word is a string. The model reaches for this constantly and quoting
  // every enum value would cost tokens for nothing.
  return raw;
}

function splitPair(token: string): [string, string] | null {
  // Find the first `=` outside a quoted string, so `label="a=b"` works.
  let inString = false;
  let escaped = false;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "=") {
      return [token.slice(0, i), token.slice(i + 1)];
    }
  }
  return null;
}

/** Parse one complete line. Returns null for blanks and comments. */
export function parseLine(line: string, lineNumber = 0): Op | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;

  const tokens = tokenize(trimmed);
  const verb = tokens[0];
  if (!verb) return null;

  switch (verb) {
    case "c": {
      const id = tokens[1];
      const type = tokens[2];
      if (!id || !type) {
        throw new LineParseError("`c` needs an id and a type", line, lineNumber);
      }
      // Component types are PascalCase by catalog rule, so requiring it here
      // costs nothing and stops an English sentence beginning with "c " from
      // parsing as a component.
      if (!/^[A-Z][A-Za-z0-9]*$/.test(type)) {
        throw new LineParseError(
          `Component type ${JSON.stringify(type)} must be PascalCase`,
          line,
          lineNumber,
        );
      }
      const props: Record<string, PropValue> = {};
      for (let i = 3; i < tokens.length; i++) {
        const token = tokens[i]!;
        const pair = splitPair(token);
        if (!pair) {
          throw new LineParseError(
            `Expected key=value, got ${JSON.stringify(token)}`,
            line,
            lineNumber,
          );
        }
        const [key, raw] = pair;
        try {
          props[key] = parseValue(raw);
        } catch {
          throw new LineParseError(
            `Could not parse value for ${JSON.stringify(key)}`,
            line,
            lineNumber,
          );
        }
      }
      const node: ComponentNode = { id, type, props, children: [] };
      return { op: "component", node };
    }

    case ">": {
      const id = tokens[1];
      if (!id) {
        throw new LineParseError("`>` needs a parent id", line, lineNumber);
      }
      return { op: "children", id, children: tokens.slice(2) };
    }

    case "d": {
      const path = tokens[1];
      if (path === undefined) {
        throw new LineParseError("`d` needs a pointer", line, lineNumber);
      }
      if (!path.startsWith("/")) {
        throw new LineParseError(
          `\`d\` needs a JSON Pointer starting with "/", got ${JSON.stringify(path)}`,
          line,
          lineNumber,
        );
      }
      const rest = tokens.slice(2).join(" ");
      if (rest === "") return { op: "data", path, value: undefined };
      let value: Json;
      try {
        value = parseValue(rest) as Json;
      } catch {
        throw new LineParseError(
          `Could not parse data value for ${path}`,
          line,
          lineNumber,
        );
      }
      return { op: "data", path, value };
    }

    case "r": {
      const id = tokens[1];
      if (!id) {
        throw new LineParseError("`r` needs an id", line, lineNumber);
      }
      // Exact arity, because `r` takes one id and nothing else. Without this,
      // the prose line "r you ready for this?" parses as a valid root op naming
      // a component called "you", and silently repoints the whole surface.
      if (tokens.length > 2) {
        throw new LineParseError(
          "`r` takes exactly one id",
          line,
          lineNumber,
        );
      }
      return { op: "root", id };
    }

    default:
      throw new LineParseError(
        `Unknown verb ${JSON.stringify(verb)}, expected c, >, d, or r`,
        line,
        lineNumber,
      );
  }
}

/**
 * Incremental line splitter. Feed it arbitrary chunks; it yields only complete
 * lines and holds the partial tail. This is the whole safety story of the
 * format: a value that has not finished arriving is simply not visible yet.
 */
export interface LineBufferOptions {
  /**
   * Called instead of throwing when a line will not parse.
   *
   * The store has a lenient mode where one bad component degrades a card rather
   * than blanking the screen. That mode is worthless if the parser throws first,
   * which is exactly what happened: a single malformed line killed the whole
   * stream before the store ever saw it. Handing errors out here lets the caller
   * decide, and keeps the default strict for anyone parsing a document directly.
   */
  onError?: (error: LineParseError) => void;
}

export class LineBuffer {
  private buf = "";
  private lineNumber = 0;
  private readonly onError: ((error: LineParseError) => void) | undefined;

  constructor(options: LineBufferOptions = {}) {
    this.onError = options.onError;
  }

  /** Parse one line, routing a failure to `onError` when one is set. */
  private parse(line: string): Op | null {
    try {
      return parseLine(line, this.lineNumber);
    } catch (err) {
      if (!this.onError) throw err;
      this.onError(
        err instanceof LineParseError
          ? err
          : new LineParseError(String(err), line, this.lineNumber),
      );
      return null;
    }
  }

  /** Complete lines only. The partial tail stays in the buffer. */
  pushRaw(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      lines.push(this.buf.slice(0, idx));
      this.buf = this.buf.slice(idx + 1);
    }
    return lines;
  }

  push(chunk: string): Op[] {
    const ops: Op[] = [];
    for (const line of this.pushRaw(chunk)) {
      this.lineNumber++;
      const op = this.parse(line);
      if (op) ops.push(op);
    }
    return ops;
  }

  /** Flush a trailing line with no newline. Call once, at end of stream. */
  flush(): Op[] {
    if (this.buf.trim() === "") {
      this.buf = "";
      return [];
    }
    const line = this.buf;
    this.buf = "";
    this.lineNumber++;
    const op = this.parse(line);
    return op ? [op] : [];
  }

  /** Discard and return the unterminated tail. For callers doing their own framing. */
  flushRaw(): string {
    const rest = this.buf;
    this.buf = "";
    if (rest.trim()) this.lineNumber++;
    return rest;
  }

  /** Bytes held back because the line is not finished. Useful in tests. */
  get pending(): string {
    return this.buf;
  }
}

/* -------------------------------------------------------------------------- */
/* Serialising, for prompts, fixtures, and the token audit                     */
/* -------------------------------------------------------------------------- */

function serializeValue(v: PropValue): string {
  if (isBinding(v)) return "@" + v.$bind;
  if (typeof v === "string") {
    // Bare words survive the round trip and cost fewer tokens than quotes.
    if (
      /^[A-Za-z][A-Za-z0-9_-]*$/.test(v) &&
      v !== "true" &&
      v !== "false" &&
      v !== "null"
    ) {
      return v;
    }
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

export function serializeOp(op: Op): string {
  switch (op.op) {
    case "component": {
      const props = Object.entries(op.node.props)
        .map(([k, v]) => `${k}=${serializeValue(v)}`)
        .join(" ");
      return `c ${op.node.id} ${op.node.type}${props ? " " + props : ""}`;
    }
    case "children":
      return `> ${op.id} ${op.children.join(" ")}`;
    case "data":
      return op.value === undefined
        ? `d ${op.path}`
        : `d ${op.path} ${JSON.stringify(op.value)}`;
    case "root":
      return `r ${op.id}`;
  }
}

export function serializeLines(ops: Op[]): string {
  return ops.map(serializeOp).join("\n") + "\n";
}

/** Parse a whole document at once. For fixtures and tests, not for streams. */
export function parseLines(source: string): Op[] {
  const buf = new LineBuffer();
  return [...buf.push(source), ...buf.flush()];
}
