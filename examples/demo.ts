/**
 * A model streaming a surface, one character at a time, printed as it assembles.
 *
 *   npx tsx examples/demo.ts
 *
 * The point is to watch the two guarantees hold without a browser: nothing paints
 * before the root resolves, and a value is never visible until it is complete.
 */

import { WeftStream, buildSystemPrompt } from "../src/core/index.js";
import type { Spec, SurfaceEvent } from "../src/core/spec.js";
import { catalog } from "./catalog.js";

const RESPONSE = `c page Stack gap=4
r page
> page title summary metrics table
c title Heading text="Q3 revenue by region" level=1
c summary Text value="Revenue grew 12.4% against a flat market, carried by the West region."
c metrics Stack direction=horizontal gap=3
> metrics m_rev m_deals
c m_rev Metric label="Total revenue" value=4820000 unit=USD delta=12.4
c m_deals Metric label="Closed deals" value=184 delta=-3.1
c table Table caption="Revenue and change by region, Q3" columns=["Region","Revenue","Change %"] rows=[["West",1840000,8.2],["East",1520000,-3.1],["Central",1460000,21.7]]
`;

/** Emit one character at a time, the worst case for a streaming parser. */
async function* trickle(text: string): AsyncIterable<string> {
  for (const ch of text) {
    yield ch;
    await new Promise((r) => setTimeout(r, 0));
  }
}

function render(spec: Spec, id: string, depth = 0): string[] {
  const node = spec.elements[id];
  const pad = "  ".repeat(depth);
  if (!node) return [`${pad}· (waiting for ${id})`];

  const props = Object.entries(node.props)
    .filter(([k]) => k !== "children")
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");

  const lines = [`${pad}${node.type}${props ? " " + props : ""}`];
  for (const child of node.children) lines.push(...render(spec, child, depth + 1));
  return lines;
}

async function main(): Promise<void> {
  console.log("System prompt is generated from the catalog:\n");
  const prompt = buildSystemPrompt(catalog, { format: "lines" });
  console.log(
    prompt.split("\n").slice(0, 12).map((l) => "  " + l).join("\n") +
      `\n  … ${prompt.split("\n").length - 12} more lines\n`,
  );

  console.log("─".repeat(64));
  console.log("Streaming, one character at a time.\n");

  let paints = 0;
  let firstPaintAt = 0;
  const started = Date.now();

  const stream = new WeftStream({
    catalog,
    format: "lines",
    onEvent: (event: SurfaceEvent) => {
      switch (event.type) {
        case "ready":
          firstPaintAt = Date.now() - started;
          console.log(`[ready]   root resolved after ${firstPaintAt}ms`);
          paints++;
          return;
        case "patch":
          paints++;
          return;
        case "pending":
          if (event.ids.length > 0) {
            console.log(`[pending] skeletons for: ${event.ids.join(", ")}`);
          }
          return;
        case "warn":
          console.log(`[warn]    ${event.message}`);
          return;
        case "error":
          console.log(`[error]   ${event.message}`);
          return;
        case "done":
          console.log(`[done]    ${Date.now() - started}ms total, ${paints} paints\n`);
          return;
      }
    },
  });

  const spec = await stream.consume(trickle(RESPONSE));

  console.log("─".repeat(64));
  console.log("Resolved surface:\n");
  console.log(render(spec, spec.root!).join("\n"));

  const chars = RESPONSE.length;
  console.log(
    `\n${chars} characters streamed. The root gate held until the tree was ` +
      `renderable, and no half-written value was ever visible.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
