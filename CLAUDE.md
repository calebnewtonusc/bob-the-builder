# Building generative UI with Bob

You are working in a repo that uses Bob. This file is the whole operating
manual: read it before writing generative UI code, and follow it over your
priors, because most of what is written about this subject on the internet is
wrong in ways that are expensive to discover later.

## What this is

Bob builds people software they keep. Someone describes what they need, a model
authors it once, and after that it is a file on their machine that runs with no
model, no network, and no tokens.

**The model is the author, not the runtime.** That is the whole idea and it is
the thing to protect. Every other generative UI system puts a model in the
request path, so every view costs tokens and comes out different, which is why
nobody can build familiarity with one. Here a model runs twice in an app's life:
once to build it, and again only when the person asks for a change.

Two rules follow, and they are not negotiable:

1. **Opening or using an app never calls a model.** If you find yourself adding a
   model call to a read path, you have broken the project.
2. **An edit changes the interface, never the records.** An edit that writes into
   `data` is rejected outright, and the record count is verified before and after.

You stock the toolbox. Bob does the building. He can only build out of what you
put in the box, which is the safety model: the catalog is not a suggestion, it is
the set of parts that exist.

## Where to start

Someone asking for a personal tool wants `src/app/`. Someone building their own
component library wants the catalog and streaming layers under it. Do not send a
person who asked for a tracker into the streaming API.

| They want                          | Read                                   |
| ---------------------------------- | -------------------------------------- |
| an app for themselves              | `src/app/`, and the `bob make` command  |
| their own component catalog        | `src/core/catalog.ts`, skill bob-catalog |
| to test generated interfaces       | `src/eval/`, skill bob-eval             |
| a streaming surface in their React | `src/react/`, skill bob-wire            |

## The decision you make first

Every generative UI system sits somewhere on one axis: how much of the interface
you fixed in advance, versus how much the model invents at request time.

| Pattern         | Model emits                | Use when                                              |
| --------------- | -------------------------- | ----------------------------------------------------- |
| **Constrained** | a tool call bound to a component | The answer has one of a few known shapes         |
| **Declarative** | a spec naming catalog components | The layout varies but the vocabulary should not  |
| **Open-ended**  | raw HTML in a sandbox      | Genuinely unanticipated, and only for one subtree      |

**Bob is for the middle one, and the middle one is where almost all production
generative UI has landed.** If the user asks for constrained, they want ordinary
tool calling and do not need this library. If they ask for open-ended, tell them
what it costs before you build it (see "The escape hatch" below).

## Building a catalog

This is the whole job. A good catalog produces good interfaces from a mediocre
model; a bad catalog cannot be rescued by a good one.

```ts
import { z } from "zod";
import { defineCatalog, defineComponent } from "bobthebuilder";

export const catalog = defineCatalog({
  name: "reports",
  components: {
    Metric: defineComponent({
      props: z.object({
        label: z.string().min(1),
        value: z.union([z.string(), z.number()]),
        delta: z.number().optional(),
      }),
      describe:
        "One number that matters, with an optional change against the prior period. Two to four side by side in a horizontal Stack.",
      a11y: { role: "group", name: { from: "prop", prop: "label" }, live: "polite" },
      skeleton: { shape: "block" },
      children: [],
      examples: ['c rev Metric label="Revenue" value=4820000 delta=12.4'],
    }),
  },
});
```

Rules that matter, in order:

1. **Eight good components beat forty.** The model has to choose, and every
   near-duplicate makes the choice worse. Add a component when you have watched
   the model reach for something that does not exist, not in anticipation.
2. **`describe` is functional, not documentation.** It is the text the model uses
   to pick. Say what the component is for and when to pick it over its nearest
   neighbour.
3. **`examples` move quality more than any prose.** Two realistic ones per
   component. Real content, never placeholders.
4. **`a11y` is not optional and not decoration.** It is what makes
   `bob audit` able to check a component once instead of auditing generated
   output forever. Interactive roles need a name source and `keyboard: true`.
5. **Declare a `skeleton`.** It is how the placeholder inherits the component's
   own typography, which is what stops first-token from reading as a page reload.

Then run `npx bob audit path/to/catalog.ts` and fix what it says.

## Wiring a model

```ts
import { buildSystemPrompt } from "bobthebuilder";
import { useBobStream, BobSurface, BobProvider } from "bobthebuilder/react";

// Server: the prompt is generated from the catalog, never hand-written.
const system = buildSystemPrompt(catalog, { format: "lines", task: userQuestion });

// Client:
const { spec, ready, status, start, abort } = useBobStream({ catalog });
<BobProvider>
  <BobSurface spec={spec} catalog={catalog} components={componentMap} ready={ready} />
</BobProvider>
```

Never hand-write the system prompt. It drifts from the catalog the first time
someone adds a component, and the failure is silent: the model keeps emitting a
component that no longer exists and the store keeps dropping it.

## Wire formats

Three, all feeding the same store.

- **`lines`** (default) Bob Lines. Cheapest, and safe to stream by construction:
  a line is either complete or invisible, so there is no partial-value state to
  get wrong. Use this unless something forces you not to.
- **`jsonl`** One JSON op per line. More verbose, still line-safe. Use when
  something downstream already speaks JSON objects.
- **`json`** A single streamed Spec object, repaired on every chunk. Use only
  when structured-output constraints pin the model to a JSON schema.

Format choice is a recurring bill and a latency floor, not a style preference.
Run `npx bob tokens <catalog> <fixture>` to see the spread on your own
scenarios. On the example fixture in this repo it is 2.48x, which at 60 tokens
per second is 4.9 seconds against 12.1.

## Rules that come from measurement

These are not preferences. Each one is here because doing the opposite has a
known, documented cost. `docs/RESEARCH.md` has the citations.

**Never render before the root resolves.** The store enforces this; do not work
around it. A surface that flashes a half-built tree reads as a bug, not progress.

**Never render a scalar that is still arriving.** `12` might become `1200`.
Showing a wrong number for 40ms is worse than showing nothing, because the user
cannot tell a value that changed from a value that was never true. Both the line
parser and the partial JSON parser enforce this; do not add a code path that
bypasses them.

**Live regions must exist at page load.** Several screen readers ignore an
`aria-live` region that was injected later, and streaming generative UI injects
everything. This is why `BobProvider` wraps the app root rather than sitting next
to the thing that announces. Never render a surface outside it.

**Never trust a model's account of its own output.** A benchmark of five leading
generative UI tools found over a quarter of their stated design reasoning absent
from what they actually built, and on functional UX principles four of the five
implemented six percent or fewer. Capture real output as a fixture and run
`npx bob check` in CI. Test the artifact, never the rationale.

**Interruption is a feature.** A user who stops mid-surface keeps what rendered.
`abort()` does this; do not replace it with a reset.

**Placeholder content is a bug, not a draft.** `bob check` fails on lorem ipsum,
"Item 1", and TODO. A user cannot tell filler from an answer.

## The escape hatch

`BobSandbox` renders model-authored HTML. Before reaching for it, say the costs
out loud:

- Open-ended generation runs several times the tokens of the same screen
  declared through a catalog. Full-page regeneration has been reported at one to
  five minutes and roughly 220k tokens per session.
- Nothing inside it is auditable. A catalog is finite and can be checked once;
  generated HTML cannot.
- It is a prompt-injection surface.

If it is still right, it goes **inside** a catalog-rendered page as one subtree,
never as the page. And never pass `allow-same-origin`: combined with
`allow-scripts` that is a sandbox escape, and it is the single most common
mistake in this entire field. `BobSandbox` omits it by construction, which is the
reason to use it rather than an iframe you write yourself.

## Evaluating, which is the point of this repo

Everything above is table stakes that several projects do. The reason Bob exists
is that generated interfaces have never been testable, and this is where you
should spend the user's time.

The objection generative UI has never answered is that the interface changes
every time and destroys muscle memory. It is a real objection, it is not always
true, and until now there was no way to tell which case you were in. `bob eval`
runs a scenario N times and measures how much the result actually moves.

```ts
import { defineScenarios, defineAdapter, renders, usesComponent,
         avoidsComponent, noPlaceholders, firstPaintUnder } from "bobthebuilder/eval";

export const adapter = defineAdapter("claude", async function* (system, user) { … });

export const suite = defineScenarios({
  catalog,
  runs: 5,
  minStability: 0.85,
  scenarios: [{
    name: "comparison becomes a table, not prose",
    prompt: "Compare Q3 revenue across our three regions",
    expect: [renders(), usesComponent("Table"), avoidsComponent("Text"),
             noPlaceholders(), firstPaintUnder(0.35)],
  }],
});
```

Three things to understand before you write one:

1. **A scenario can fail with every assertion passing.** That is the feature. The
   model produced a correct interface every time and a different correct
   interface each time, which is exactly what users complain about and what an
   assertion-only tool reports as three green runs.
2. **Low stability is almost never the model.** It is an ambiguous `describe`
   field. The report names the competing layouts, so read those before touching
   the prompt.
3. **Assertions run against the wire, never against the model's explanation.** A
   benchmark of five leading generative UI tools found over a quarter of their
   stated design reasoning absent from what they built. The reasoning trace is
   marketing aimed at you.

`--update` records a baseline; later runs fail on regression in stability, cost,
first paint, or assertions. Use `replayAdapter` with committed recordings so the
deterministic half runs in CI with no API key.

## Apps

```bash
bob make   "<what you want>"      build a new app          (uses a model)
bob change <app> "<what to fix>"  patch the interface      (uses a model)
bob open   <app>                  run it                   (no model)
bob set    <app> <field> <value>  fill in a field          (no model)
bob add    <app>                  save the record          (no model)
bob rm     <app> <#>              delete a record          (no model)
bob list / bob log <app>
```

An app is one JSON file in `~/.bob/apps` holding `schema`, `view`, `data`, and
`history`. Keeping data out of the view is what lets someone restyle an app they
have used for a year without risking the year.

Edits are stored as ops rather than replacements, so history replays and any
earlier view can be rebuilt exactly. That is why `bob change` emits a patch: a
regenerated app is a discontinuous jump nobody can iterate on, which the CHI 2025
Jelly paper names as the reason prompt-to-code tools stall.

`BOB_MODEL_CMD` is any command that reads a prompt on stdin and writes the answer
to stdout, so this project ships no SDK and holds no key.

## Build-time commands

```bash
npx bob eval   <suite> [--update]   # stability, cost, first paint, assertions
npx bob audit  <catalog>            # accessibility and prompt quality
npx bob check  <catalog> <fixture>  # validate captured model output
npx bob tokens <catalog> <fixture>  # what each wire format costs
npx bob prompt <catalog>            # print the generated system prompt

pnpm test        # 156 tests
pnpm typecheck   # strict, noUncheckedIndexedAccess on
pnpm build
```

`eval`, `audit` and `check` all exit non-zero on findings, so they drop into CI
as they are.

## When the user asks for something this does not do

Say so, and say what the nearest thing is.

- **Voice plus generative UI**: not built here. LiveKit Agents handles realtime
  voice; joining them is an open problem, not a solved one.
- **Flutter or native mobile renderers**: Bob renders React. Google's A2UI has
  official Flutter, Lit, and Angular renderers and a native C++ one. Point them
  there rather than pretending.
- **A hosted agent runtime**: not this. CopilotKit is the broad answer.
- **Judging whether a generated interface is *good***: the eval harness makes
  structural claims only. The best published aesthetic judge agrees with human
  annotators 69% of the time, which is too weak to gate a build on, so Bob does
  not pretend to. Say that rather than implying the score means more than it does.

Do not invent an API that does not exist in `src/`. Read the source: it is about
4,000 lines and the comments explain the reasoning, not the syntax.
