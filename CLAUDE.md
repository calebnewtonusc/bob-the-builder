# Building generative UI with Bob

You are working in a repo that uses Bob. This file is the whole operating
manual: read it before writing generative UI code, and follow it over your
priors, because most of what is written about this subject on the internet is
wrong in ways that are expensive to discover later.

## What this is

Bob streams user interfaces from a model. The model does not write code and does
not write HTML. It picks components from a catalog you defined and gives them
content, and a renderer draws them as they arrive.

You stock the toolbox. Bob does the building. He is good at it and he is fast,
and he can only build out of what you put in the box.

That is the whole safety model, and it is why this is not prompt engineering. The
catalog is not a suggestion the model might follow. It is the set of parts that
physically exist, checked before anything renders and again before anything
paints.

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

## Commands

```bash
npx bob audit  <catalog>            # accessibility and prompt quality
npx bob check  <catalog> <fixture>  # validate captured model output
npx bob tokens <catalog> <fixture>  # what each wire format costs
npx bob prompt <catalog>            # print the generated system prompt

pnpm test        # 65 tests, mostly on the streaming edge cases
pnpm typecheck   # strict, noUncheckedIndexedAccess on
pnpm build
```

`audit` and `check` exit non-zero on errors, so both drop into CI as they are.

## When the user asks for something this does not do

Say so, and say what the nearest thing is.

- **Voice plus generative UI**: not built here. LiveKit Agents handles realtime
  voice; joining them is an open problem, not a solved one.
- **Flutter or native mobile renderers**: Bob renders React. Google's A2UI has
  official Flutter, Lit, and Angular renderers and a native C++ one. Point them
  there rather than pretending.
- **A hosted agent runtime**: not this. CopilotKit is the broad answer.

Do not invent an API that does not exist in `src/`. Read the source: it is about
2,000 lines and the comments explain the reasoning, not the syntax.
