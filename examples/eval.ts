/**
 * An eval suite.
 *
 *   npx bob eval examples/eval.ts            compare against the baseline
 *   npx bob eval examples/eval.ts --update   record a new baseline
 *
 * The adapter here replays recorded responses so this runs offline, in CI, on a
 * fork, with no API key, and gives the same answer every time. Swap it for
 * `defineAdapter` pointed at a real model to measure stability, which is the one
 * metric that genuinely needs live runs, because varying is what it measures.
 *
 *   export const adapter = defineAdapter("claude", async function* (system, user) {
 *     const stream = await client.messages.stream({
 *       model: "claude-sonnet-5",
 *       max_tokens: 2048,
 *       system,
 *       messages: [{ role: "user", content: user }],
 *     });
 *     for await (const event of stream) {
 *       if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
 *         yield event.delta.text;
 *       }
 *     }
 *   });
 */

import {
  allInteractiveNamed,
  avoidsComponent,
  defineScenarios,
  firstPaintUnder,
  maxDepth,
  maxTokens,
  noPlaceholders,
  noWarnings,
  renders,
  replayAdapter,
  usesComponent,
} from "../src/eval/index.js";
import { catalog } from "./catalog.js";

/**
 * Recorded model output. Three takes on each prompt, deliberately not identical,
 * because a fixture set where every run matches would report perfect stability
 * and teach nothing.
 */
const RECORDINGS: Record<string, string[]> = {
  "Compare Q3 revenue across our three regions": [
    `c page Stack gap=4
r page
> page title table
c title Heading text="Q3 revenue by region" level=1
c table Table caption="Revenue and change by region, Q3" columns=["Region","Revenue","Change %"] rows=[["West",1840000,8.2],["East",1520000,-3.1],["Central",1460000,21.7]]
`,
    `c page Stack gap=4
r page
> page title table
c title Heading text="Revenue by region, Q3" level=1
c table Table caption="Q3 revenue and quarter-over-quarter change" columns=["Region","Revenue","Change %"] rows=[["West",1840000,8.2],["East",1520000,-3.1],["Central",1460000,21.7]]
`,
    // A third layout: same components, an extra summary line. This is the run
    // that pulls shape stability below 1.0, which is the honest result.
    `c page Stack gap=4
r page
> page title summary table
c title Heading text="Q3 revenue by region" level=1
c summary Text value="West led on both absolute revenue and growth; East contracted 3.1%."
c table Table caption="Revenue and change by region, Q3" columns=["Region","Revenue","Change %"] rows=[["West",1840000,8.2],["East",1520000,-3.1],["Central",1460000,21.7]]
`,
  ],

  "How much revenue did we close last quarter, and how many deals?": [
    `c page Stack gap=4
r page
> page metrics
c metrics Stack direction=horizontal gap=3
> metrics rev deals
c rev Metric label="Total revenue" value=4820000 unit=USD delta=12.4
c deals Metric label="Closed deals" value=184 delta=-3.1
`,
    `c page Stack gap=4
r page
> page metrics
c metrics Stack direction=horizontal gap=3
> metrics rev deals
c rev Metric label="Revenue closed" value=4820000 unit=USD delta=12.4
c deals Metric label="Deals closed" value=184 delta=-3.1
`,
    `c page Stack gap=4
r page
> page metrics
c metrics Stack direction=horizontal gap=3
> metrics rev deals
c rev Metric label="Total revenue" value=4820000 unit=USD delta=12.4
c deals Metric label="Closed deals" value=184 delta=-3.1
`,
  ],

  "Let me request a demo": [
    `c page Stack gap=4
r page
> page title email submit
c title Heading text="Request a demo" level=1
c email Field label="Work email" kind=email value=@/contact/email
c submit Button label="Send request" action=send_report variant=primary
d /contact/email ""
`,
    `c page Stack gap=4
r page
> page title email submit
c title Heading text="Book a demo" level=1
c email Field label="Work email address" kind=email value=@/contact/email
c submit Button label="Request demo" action=send_report variant=primary
d /contact/email ""
`,
    `c page Stack gap=4
r page
> page title email submit
c title Heading text="Request a demo" level=1
c email Field label="Work email" kind=email value=@/contact/email
c submit Button label="Send request" action=send_report variant=primary
d /contact/email ""
`,
  ],
};

export const adapter = replayAdapter(RECORDINGS, { name: "recorded" });

export const suite = defineScenarios({
  catalog,
  runs: 3,
  minStability: 0.8,

  scenarios: [
    {
      name: "comparison becomes a table, not prose",
      prompt: "Compare Q3 revenue across our three regions",
      expect: [
        renders(),
        // The failure this catches is a model answering a comparison in
        // paragraphs. It has technically answered and has actually failed.
        usesComponent("Table"),
        noPlaceholders(),
        noWarnings(),
        maxDepth(3),
        maxTokens(400),
        // Regression guard on prompt ordering: claiming the root last measured
        // 23x worse time to first paint on an identical response.
        firstPaintUnder(0.35),
      ],
    },
    {
      name: "how much / how many becomes metrics",
      prompt: "How much revenue did we close last quarter, and how many deals?",
      expect: [
        renders(),
        usesComponent("Metric", 2),
        avoidsComponent("Table"),
        noPlaceholders(),
        noWarnings(),
        firstPaintUnder(0.35),
      ],
    },
    {
      name: "a request becomes a bound, named form",
      prompt: "Let me request a demo",
      expect: [
        renders(),
        usesComponent("Field"),
        usesComponent("Button"),
        // Every control a screen reader has to announce carries a real name.
        allInteractiveNamed(),
        noPlaceholders(),
        noWarnings(),
        firstPaintUnder(0.35),
      ],
    },
  ],
});

export default suite;
