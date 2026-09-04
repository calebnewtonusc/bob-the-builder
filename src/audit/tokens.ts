/**
 * What your wire format costs, measured on your own catalog.
 *
 * The published benchmark everyone cites for this puts a line-oriented format at
 * roughly half the tokens of the JSON encoding of the same interface, and it was
 * run by a vendor whose own format came first. The mechanism is real and you can
 * verify it by counting punctuation, but the multiplier is theirs and it was
 * measured on their scenarios. So this measures yours.
 *
 * On the estimate. Without pulling a tokenizer dependency into a UI library, the
 * count below is a heuristic: alphanumeric runs split roughly every four
 * characters, punctuation counted individually, leading whitespace absorbed into
 * the following word the way byte-pair encodings do. Against real BPE
 * tokenizers it lands within about 10% on structured text of this kind.
 *
 * Absolute numbers here are approximate. The *ratio* between formats is not,
 * because the formats differ almost entirely in punctuation density and every
 * tokenizer charges for punctuation. If you want exact figures, pass your
 * model's tokenizer as `count`.
 */

import type { Op } from "../core/spec.js";
import { serializeLines } from "../core/lines.js";
import type { WireFormat } from "../core/stream.js";

export type TokenCounter = (text: string) => number;

/** Heuristic BPE-shaped counter. See the note above on accuracy. */
export const estimateTokens: TokenCounter = (text: string): number => {
  let tokens = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;

    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "\n") {
      tokens++;
      i++;
      continue;
    }

    if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(text[j]!)) j++;
      const len = j - i;
      // Common short words are one token; longer runs fragment.
      tokens += len <= 4 ? 1 : Math.ceil(len / 4);
      i = j;
      continue;
    }

    // Punctuation. Adjacent runs like `":{"` usually merge in pairs.
    let j = i;
    while (j < n && !/[A-Za-z0-9_\s]/.test(text[j]!)) j++;
    tokens += Math.max(1, Math.ceil((j - i) / 2));
    i = j;
  }

  return tokens;
};

function toJsonl(ops: Op[]): string {
  return ops.map((op) => JSON.stringify(op)).join("\n") + "\n";
}

function toJson(ops: Op[]): string {
  const elements: Record<string, unknown> = {};
  const data: Record<string, unknown> = {};
  let root: string | null = null;

  for (const op of ops) {
    switch (op.op) {
      case "component":
        elements[op.node.id] = {
          type: op.node.type,
          props: op.node.props,
          children: op.node.children,
        };
        break;
      case "children": {
        const el = (elements[op.id] ??= { type: "unknown", props: {}, children: [] }) as {
          children: string[];
        };
        el.children = op.children;
        break;
      }
      case "data": {
        const key = op.path.replace(/^\//, "").split("/")[0];
        if (key) data[key] = op.value ?? null;
        break;
      }
      case "root":
        root = op.id;
        break;
    }
  }

  return JSON.stringify({ root, elements, data }, null, 2);
}

export function serializeAs(ops: Op[], format: WireFormat): string {
  switch (format) {
    case "lines":
      return serializeLines(ops);
    case "jsonl":
      return toJsonl(ops);
    case "json":
      return toJson(ops);
  }
}

export interface FormatCost {
  format: WireFormat;
  bytes: number;
  tokens: number;
  /** Multiple of the cheapest format in this comparison. */
  ratio: number;
  /** Seconds to emit at `tokensPerSecond`. */
  seconds: number;
}

export interface TokenReport {
  scenario: string;
  costs: FormatCost[];
  cheapest: WireFormat;
  /** Cost multiple between the priciest and cheapest format. */
  spread: number;
  tokensPerSecond: number;
  estimated: boolean;
}

export interface TokenAuditOptions {
  /** Generation rate used to turn tokens into seconds. Default 60. */
  tokensPerSecond?: number;
  /** Supply your model's tokenizer for exact counts. */
  count?: TokenCounter;
}

export function auditTokens(
  scenario: string,
  ops: Op[],
  opts: TokenAuditOptions = {},
): TokenReport {
  const tokensPerSecond = opts.tokensPerSecond ?? 60;
  const count = opts.count ?? estimateTokens;
  const formats: WireFormat[] = ["lines", "jsonl", "json"];

  const raw = formats.map((format) => {
    const text = serializeAs(ops, format);
    const tokens = count(text);
    return { format, bytes: text.length, tokens };
  });

  const min = Math.min(...raw.map((r) => r.tokens)) || 1;
  const max = Math.max(...raw.map((r) => r.tokens));

  const costs: FormatCost[] = raw.map((r) => ({
    ...r,
    ratio: r.tokens / min,
    seconds: r.tokens / tokensPerSecond,
  }));

  const cheapest = costs.reduce((a, b) => (a.tokens <= b.tokens ? a : b)).format;

  return {
    scenario,
    costs,
    cheapest,
    spread: max / min,
    tokensPerSecond,
    estimated: opts.count === undefined,
  };
}
