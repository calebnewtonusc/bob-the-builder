/**
 * Partial JSON: turn a prefix of a JSON document into the largest valid JSON
 * document it definitely contains.
 *
 * The failure this exists to prevent: a plain parser can do nothing with
 * `{"total": 12` until more arrives, so a naively streamed structured response
 * shows a blank screen and then everything at once. You paid the complexity of
 * streaming and got the batch experience.
 *
 * The rule that keeps it honest is that a value is only visible once it is
 * closed. `12` might be the first half of `1200`, so a number still being
 * written is dropped rather than shown, and a string missing its closing quote
 * takes its own key with it. Rendering a wrong number for 40ms is worse than
 * rendering nothing, because the user cannot tell the difference between a
 * value that changed and a value that was never true.
 *
 * Implementation: scan once, remembering for each open container the offset
 * just past its last *completed* member. At end of input, truncate to the
 * innermost such offset and close every open container. Anything mid-token is
 * behind that offset and disappears on its own.
 */

export interface PartialResult<T = unknown> {
  /** Parsed value, or undefined when nothing complete has arrived yet. */
  value: T | undefined;
  /** True when the input was already a complete JSON document. */
  complete: boolean;
  /** True when trailing incomplete content was discarded to make it parse. */
  repaired: boolean;
}

interface Frame {
  close: "}" | "]";
  /** Offset just past the last complete member of this container. */
  safeEnd: number;
  /**
   * Whether anything in this container has finished arriving.
   *
   * Closing a container that has no complete member invents a value: `[{"a":1},{`
   * would become `[{"a":1},{}]`, adding a row that is not in the data and that a
   * caller cannot distinguish from a real empty one. So an empty frame is
   * discarded rather than closed.
   */
  hasMember: boolean;
  /** For objects: whether the next string is a key or a value. */
  expecting: "key" | "value";
}

const WS = new Set([" ", "\t", "\n", "\r"]);

export function parsePartialJson<T = unknown>(src: string): PartialResult<T> {
  const stack: Frame[] = [];
  let i = 0;
  const n = src.length;

  /** Offset just past the last complete top-level value. */
  let topSafeEnd = 0;
  let sawTopValue = false;

  /** Record that a value ended at offset `end`, at the current depth. */
  const completeValue = (end: number): void => {
    const top = stack[stack.length - 1];
    if (top) {
      top.safeEnd = end;
      top.hasMember = true;
    } else {
      topSafeEnd = end;
      sawTopValue = true;
    }
  };

  while (i < n) {
    const ch = src[i]!;

    if (WS.has(ch)) {
      i++;
      continue;
    }

    // Track whether an object is expecting a key or a value, so a string that
    // arrives last can be classified without guessing. `{"a":"hi"` keeps its
    // value; `{"a":1,"b"` drops the dangling key.
    if (ch === ":") {
      const top = stack[stack.length - 1];
      if (top) top.expecting = "value";
      i++;
      continue;
    }
    if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top && top.close === "}") top.expecting = "key";
      i++;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push({
        close: ch === "{" ? "}" : "]",
        safeEnd: i + 1,
        hasMember: false,
        expecting: ch === "{" ? "key" : "value",
      });
      i++;
      continue;
    }

    if (ch === "}" || ch === "]") {
      stack.pop();
      i++;
      completeValue(i);
      continue;
    }

    if (ch === '"') {
      // Scan to the closing quote. An unterminated string is not a value, so we
      // stop without calling completeValue and the whole token falls away.
      let j = i + 1;
      let escaped = false;
      let closed = false;
      while (j < n) {
        const c = src[j]!;
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) break;
      i = j + 1;

      // A string in key position is not a complete member: the pair is only done
      // once its value lands.
      const top = stack[stack.length - 1];
      const isKey = top?.close === "}" && top.expecting === "key";
      if (!isKey) completeValue(i);
      continue;
    }

    // Number, true, false, null. Complete only once a delimiter proves it ended.
    let j = i;
    while (j < n) {
      const c = src[j]!;
      if (WS.has(c) || c === "," || c === "}" || c === "]") break;
      j++;
    }
    if (j >= n) break; // ran out of input mid-token: drop it
    i = j;
    completeValue(j);
  }

  if (stack.length === 0) {
    if (!sawTopValue) return { value: undefined, complete: false, repaired: false };
    const head = src.slice(0, topSafeEnd);
    const complete = src.slice(topSafeEnd).trim() === "";
    try {
      return {
        value: JSON.parse(head) as T,
        complete,
        repaired: !complete,
      };
    } catch {
      return { value: undefined, complete: false, repaired: true };
    }
  }

  // Close from the innermost container that actually holds something. Frames
  // inside that one are empty, and closing them would invent a value.
  let keep = 0;
  for (let d = stack.length - 1; d >= 0; d--) {
    if (stack[d]!.hasMember) {
      keep = d;
      break;
    }
  }

  let candidate = src.slice(0, stack[keep]!.safeEnd);
  for (let d = keep; d >= 0; d--) candidate += stack[d]!.close;

  try {
    return { value: JSON.parse(candidate) as T, complete: false, repaired: true };
  } catch {
    return { value: undefined, complete: false, repaired: true };
  }
}

/**
 * Streaming wrapper. Feed chunks, read the best-known value after each one.
 *
 * Re-parsing the accumulated buffer on every chunk is O(n) per chunk and O(n²)
 * over a response. That is the right trade at UI sizes: a large generated
 * surface is tens of kilobytes, the parse is microseconds, and an incremental
 * parser here would be a meaningful amount of state to get wrong for no gain a
 * user could perceive. If you are streaming megabytes into this, use Weft Lines
 * instead, which is genuinely incremental.
 */
export class PartialJsonStream<T = unknown> {
  private buf = "";
  private last: PartialResult<T> = {
    value: undefined,
    complete: false,
    repaired: false,
  };

  push(chunk: string): PartialResult<T> {
    this.buf += chunk;
    this.last = parsePartialJson<T>(this.buf);
    return this.last;
  }

  get current(): PartialResult<T> {
    return this.last;
  }

  get raw(): string {
    return this.buf;
  }

  reset(): void {
    this.buf = "";
    this.last = { value: undefined, complete: false, repaired: false };
  }
}
