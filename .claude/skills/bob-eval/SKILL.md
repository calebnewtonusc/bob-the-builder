---
name: bob-eval
description: Write and run an eval suite for a generative UI catalog. Use when the user wants to test generated interfaces, measure whether their UI is stable across runs, gate generative UI in CI, investigate why a generated interface keeps changing, or compare models and prompts for a catalog.
---

# Evaluating generated interfaces

Generated interfaces have never been testable in the way the rest of a codebase
is. This is the tool for it, and stability is the metric nothing else computes.

## Start with the question the user actually has

Nearly every request here is one of four:

| They say                                   | They want                                  |
| ------------------------------------------ | ------------------------------------------ |
| "the layout keeps changing"                | stability, and the variants list           |
| "how do I test this in CI"                 | a suite plus a committed baseline          |
| "is model X better than Y for this"        | the same suite, two adapters, compare      |
| "it looks right but sometimes it's wrong"  | assertions, especially `avoidsComponent`   |

## The shape of a suite

```ts
import {
  defineScenarios, defineAdapter,
  renders, usesComponent, avoidsComponent, allInteractiveNamed,
  noPlaceholders, noWarnings, maxDepth, maxTokens, firstPaintUnder,
} from "bobthebuilder/eval";
import { catalog } from "./catalog.js";

export const adapter = defineAdapter("claude", async function* (system, user) {
  const stream = await client.messages.stream({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: user }],
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
});

export const suite = defineScenarios({
  catalog,
  runs: 5,
  minStability: 0.85,
  scenarios: [ /* … */ ],
});
```

Then `npx bob eval suite.ts`.

## Writing scenarios that catch real failures

A scenario is a prompt plus claims about what must come back. Write the prompt
the way a user would type it, not the way the catalog is organised.

The most valuable assertion is usually a **negative** one. `usesComponent("Table")`
catches a model that ignored the data entirely; `avoidsComponent("Text")` catches
the far more common failure where the model describes a table in prose. It has
technically answered and it has actually failed, and only the negative assertion
sees it.

Reach for these in roughly this order:

- `renders()` — first, always. Everything else is meaningless if nothing assembled.
- `usesComponent(type, atLeast?)` / `avoidsComponent(type)` / `usesOneOf([…])`
- `noPlaceholders()` — filler is indistinguishable from an answer to a user who
  does not already know the answer
- `allInteractiveNamed()` — every control a screen reader must announce
- `firstPaintUnder(0.35)` — guards the prompt ordering; see below
- `maxTokens` / `maxDepth` / `maxComponents` — cost and complexity budgets
- `noWarnings()` — the store assembled cleanly
- `custom(name, fn)` — anything the built-ins do not cover

Set `runs` to at least 3, and 5 if you can afford it. Stability across two runs
is barely a measurement.

## Reading the report

```
✗ comparison becomes a table, not prose
  stability  ████████░░░░ 0.68  (min 0.8)
    components 0.83  shape 0.33  depth 1.00
    2 distinct layouts across 3 runs:
      2× Stack(Heading,Table)
      1× Stack(Heading,Text,Table)
```

**A scenario can fail with every assertion green.** That is the whole point. The
model was correct all three times and different on the third.

Diagnose by which sub-metric dropped:

- **components low** — the model is answering with different building blocks run
  to run. Usually two catalog entries whose `describe` fields overlap, so it
  cannot tell them apart. Rewrite them to say when to pick one over the other.
- **shape low, components high** — same parts, different arrangement. Usually a
  container the model adds optionally. Either make it required in an example or
  accept it and lower `minStability`.
- **depth low** — a wrapper is appearing sometimes. Same fix as shape.

The instinct is to blame the model or fiddle with temperature. It is almost
always the catalog, and the variants list tells you which components disagree.

## Baselines

```bash
npx bob eval suite.ts --update   # record
npx bob eval suite.ts            # compare, exit 1 on regression
```

The baseline is what makes this a gate rather than a dashboard. Generated
interfaces drift for reasons invisible to a type checker: a model version
changes, someone rewords a `describe`, a prompt gets edited. Committed numbers
turn that into a failing check with a diff.

Regressions are reported on stability, token cost, first paint, and assertion
count, with tolerances so ordinary model nondeterminism does not fail the build.

## Running without an API key

```ts
import { replayAdapter } from "bobthebuilder/eval";
export const adapter = replayAdapter({
  "Compare Q3 revenue across our three regions": [recorded1, recorded2, recorded3],
});
```

Capture real output once, commit it, and the deterministic half of the suite runs
offline, on a fork, in CI, identically every time. Stability still needs live runs
to mean anything, because varying is what it measures, so the usual arrangement
is replay in CI and live runs before a release or a model bump.

## First paint

`firstPaintUnder(fraction)` measures how far into the stream the root resolved.
Nothing can paint before that, so it is the real time-to-first-content.

This exists because of a measured regression: claiming the root component second
instead of last moved first paint from 665ms to 29ms on an identical response, a
23× difference from ordering alone. The generated prompt teaches the fast order.
This assertion catches anything that puts it back.

## Be honest about the boundary

The harness makes structural claims. It does not judge whether an interface is
*good*, and it should not pretend to: the best published aesthetic judge for
generated interfaces agrees with human annotators about 69% of the time. Tell the
user that rather than letting a green run imply more than it means.
