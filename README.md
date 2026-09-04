# Bob-the-Builder

**Streaming generative UI for TypeScript, with the first eval harness for generated interfaces.**

You stock the toolbox. Bob does the building. He is good at it and he is fast,
and he can only build out of what you put in the box.

The model does not write code and does not write HTML. It picks components from
a catalog you defined and gives them content, and a renderer draws them as they
arrive. That part is a solved problem and several projects do it well.

The part nobody has built is how you know it works.

```bash
npm install bobthebuilder zod
```

## The problem this solves

Generative UI has one objection that has never had an answer: **the interface
changes every time.** People learn where things are, and a screen that
rearranges itself makes them relearn the same task forever.

Everyone repeats that objection. Nobody measures it. There is no number you can
put in a pull request, no threshold you can fail a build on, and no way to tell
a catalog that is safe to ship from one that is a demo.

So Bob measures it.

```
$ npx bob eval examples/eval.ts

starter · 3 scenarios × 3 runs · recorded

  ✗ comparison becomes a table, not prose
    stability  ████████░░░░ 0.68  (min 0.8)
      components 0.83  shape 0.33  depth 1.00
      2 distinct layouts across 3 runs:
        2× Stack(Heading,Table)
        1× Stack(Heading,Text,Table)
    cost       118 tokens   first paint at 16% of stream
    ✓ renders 3/3
    ✓ uses Table 3/3
    ✓ no placeholder content 3/3
    ✓ depth ≤ 3 3/3
    ✓ first paint < 35% of stream 3/3

  ✓ how much / how many becomes metrics
    stability  ████████████ 1.00  (min 0.8)

  2/3 scenarios pass
```

Read the failing one carefully. **Every assertion passed and the scenario still
failed.** The model produced a correct interface all three times and produced a
*different* correct interface on the third, and that is the thing users complain
about. An assertion-only tool reports three green runs and tells you nothing.

It also names the disagreement instead of only scoring it: two runs gave
`Stack(Heading,Table)`, one added a `Text`. The fix is almost never the model. It
is an ambiguous `describe` field in the catalog.

## Why nothing else does this

There is prior art on evaluating generated interfaces and none of it is a tool
you can run.

- **Design Theater** (arXiv 2607.22928) measured five leading generative UI tools
  and found over a quarter of their stated design reasoning absent from what they
  actually built, with functional UX principles at six percent or fewer in four
  of five. A one-off academic study, not a harness.
- **PAGEN** (Google) is a dataset.
- **GE-Score** (Stanford, arXiv 2508.19227) is a VLM-judged rubric that agrees
  with human annotators 69% of the time. Useful for research, too weak to gate a
  build.

Nothing maintained runs in CI against *your* catalog. That gap is what `bob eval`
fills, and stability is a metric none of the above computes at all.

Everything Bob measures is deterministic and derived from the specs themselves,
with no model in the judging loop, precisely because the best available judge is
at 69%.

## Writing an eval

```ts
import {
  defineScenarios, defineAdapter,
  renders, usesComponent, avoidsComponent,
  allInteractiveNamed, noPlaceholders, firstPaintUnder, maxTokens,
} from "bobthebuilder/eval";

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
  scenarios: [
    {
      name: "comparison becomes a table, not prose",
      prompt: "Compare Q3 revenue across our three regions",
      expect: [
        renders(),
        usesComponent("Table"),
        // A model that answers a comparison in paragraphs has technically
        // answered and has actually failed.
        avoidsComponent("Text"),
        allInteractiveNamed(),
        noPlaceholders(),
        maxTokens(600),
        firstPaintUnder(0.35),
      ],
    },
  ],
});
```

`npx bob eval suite.ts --update` records a baseline. Every later run compares
against it and fails on regression, so a model version bump, a reworded
`describe`, or a prompt edit arrives as a failing check with a diff rather than
as a support ticket.

Use `replayAdapter` with committed recordings to run the deterministic half of
the suite offline, in CI, on a fork, with no API key.

## What it measures

| Metric          | What it tells you                                                  |
| --------------- | ------------------------------------------------------------------ |
| **stability**   | How much the interface moves across runs of the same prompt         |
| ↳ components    | Did the same components appear, in the same quantities              |
| ↳ shape         | Did the tree have the same structure                                |
| ↳ depth         | Did the tree stay the same size                                     |
| **first paint** | How far into the stream before the user sees anything               |
| **cost**        | Mean tokens per response                                           |
| assertions      | Structural claims about what actually arrived on the wire           |

First paint deserves its own note. Bob's demo found that claiming the root
component second instead of last moves first paint from 665ms to 29ms on an
identical response, a **23×** difference from pure ordering. The generated prompt
teaches the fast order, and `firstPaintUnder()` is the assertion that catches a
regression putting it back.

## The rest of it

The streaming half is a real implementation, built on what the research actually
measured. Every decision below traces to a citation in
[`docs/RESEARCH.md`](docs/RESEARCH.md).

```ts
import { z } from "zod";
import { defineCatalog, defineComponent, buildSystemPrompt } from "bobthebuilder";

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
        "One number that matters, with an optional change against the prior period.",
      a11y: { role: "group", name: { from: "prop", prop: "label" }, live: "polite" },
      skeleton: { shape: "block" },
      children: [],
      examples: ['c rev Metric label="Revenue" value=4820000 delta=12.4'],
    }),
  },
});
```

```tsx
import { useBobStream, BobProvider, BobSurface, type ComponentMap } from "bobthebuilder/react";

// Typed against the catalog: a missing component or a misspelled prop is a
// compile error, not a silently dropped card.
const components: ComponentMap<typeof catalog.components> = {
  Metric: ({ label, value, delta }) => <Stat label={label} value={value} delta={delta} />,
};

function Report({ question }: { question: string }) {
  const { spec, ready, status, start, abort } = useBobStream({ catalog });
  return (
    <BobProvider>
      <button onClick={() => start(streamFromYourModel(question))}>Ask</button>
      {status === "streaming" && <button onClick={abort}>Stop</button>}
      <BobSurface spec={spec} catalog={catalog} components={components} ready={ready} />
    </BobProvider>
  );
}
```

The system prompt is generated from the catalog, so it cannot drift from it:

```ts
const system = buildSystemPrompt(catalog, { format: "lines", task: question });
```

### Design decisions that came from the research

**The wire format is a flat map, not a tree.** Google's A2UI and Vercel's
json-render were built independently and both landed here. A nested tree cannot
be patched or streamed out of order; a flat map can.

**Nothing renders before the root resolves.** A surface that flashes a half-built
tree reads as a bug rather than as progress.

**A value is invisible until it is closed.** `12` might still become `1200`.
Showing a wrong number for 40ms is worse than showing nothing, because a user
cannot tell a value that changed from a value that was never true.

**Live regions are mounted at page load, empty.** Several screen readers ignore an
`aria-live` region injected later, and streaming injects everything. This is the
failure where the smoother your interface looks, the more completely it fails for
anyone not watching it. `BobProvider` makes it structural.

**Props are allow-listed, not just validated.** Model output is spread onto React
components, so an undeclared prop is an XSS hole rather than a cosmetic problem.
The catalog's declared prop names are the allow-list.

## The audit tools

```
$ npx bob audit examples/catalog.ts     # the catalog, before anything renders
$ npx bob check examples/catalog.ts examples/fixtures/report.bl
$ npx bob tokens examples/catalog.ts examples/fixtures/report.bl
```

`audit` checks the catalog because a catalog is finite and the same on every
request, so checking one component checks every interface ever built from it.
Auditing generated HTML means auditing an artifact that will never exist again.

`check` runs against captured model output and catches dangling children, cycles,
unreachable components, missing accessible names, and placeholder content.

`tokens` measures wire-format cost on your own catalog. The published benchmark
everyone cites was run by a vendor whose own format won it; this measures yours.
On the example fixture it reports a 2.48× spread between cheapest and priciest.

All three exit non-zero on findings, so they drop into CI as they are.

## Wire formats

| Format  | Shape                     | Use when                                            |
| ------- | ------------------------- | --------------------------------------------------- |
| `lines` | `c hero Metric label="…"` | Default. Cheapest, and stream-safe by construction   |
| `jsonl` | One JSON op per line      | Something downstream already speaks JSON objects     |
| `json`  | One streamed Spec object  | Structured output pins the model to a JSON schema    |

Bob Lines is four verbs:

```
c page Stack gap=4
r page
> page title metrics
c title Heading text="Q3 revenue by region" level=1
c metrics Metric label="Total revenue" value=@/totals/revenue delta=12.4
d /totals/revenue 4820000
```

`c` declares a component, `r` the root, `>` its children, `d` patches the data
model. `@/pointer` binds a prop so a value updates without rebuilding the
component. Note the ordering: root claimed second, which is the 23× above.

## The escape hatch

`BobSandbox` renders model-authored HTML for the one subtree that needs it. It
exists mostly so you do not write the iframe yourself.

An iframe carrying both `allow-scripts` and `allow-same-origin` **is not
sandboxed**: together they let the framed script reach the parent document or
remove its own `sandbox` attribute. That combination appears constantly in
tutorials because each flag looks individually reasonable. `BobSandbox` omits
`allow-same-origin` and both top-navigation flags by construction, and there are
tests asserting it stays that way.

## API

**`bobthebuilder`** — `defineCatalog` `defineComponent` `defineAction` ·
`BobStream` `SurfaceStore` `resolveProps` · `buildSystemPrompt` · `LineBuffer`
`parseLines` `serializeLines` · `parsePartialJson` `PartialJsonStream` · `getAt`
`setAt` `parsePointer`

**`bobthebuilder/react`** — `BobProvider` `BobSurface` `useBobStream`
`useAnnouncer` `BobSkeleton` `BobSandbox` `ComponentMap`

**`bobthebuilder/eval`** — `defineScenarios` `runEval` `measureStability`
`defineAdapter` `replayAdapter` `compareToBaseline` · assertions: `renders`
`usesComponent` `avoidsComponent` `usesOneOf` `maxDepth` `maxComponents`
`maxTokens` `firstPaintUnder` `allInteractiveNamed` `noPlaceholders`
`noWarnings` `bindsData` `custom`

**`bobthebuilder/audit`** — `auditA11y` `validateOps` `auditTokens`
`estimateTokens`

## Using this with Claude Code

Drop the repo in and [`CLAUDE.md`](CLAUDE.md) teaches the agent the whole model:
the pattern decision, catalog design, format choice, and the rules that come from
measurement rather than taste. Skills in [`.claude/skills/`](.claude/skills/)
cover building a catalog, wiring a model, and auditing what comes back.

## What this does not do

- **Voice.** LiveKit Agents handles realtime voice well. Joining it to streaming
  generative UI is an open problem and this does not solve it.
- **Flutter, Lit, Angular, native mobile.** Bob renders React. Google's A2UI has
  official renderers for all of those plus a native C++ one.
- **An agent runtime.** Bring your own. Bob takes an async iterable of strings.
- **Aesthetic judgement.** The eval harness makes structural claims only. Nothing
  available scores whether a generated interface is *good* reliably enough to
  gate a build on.

## Development

```bash
pnpm install
pnpm test        # 156 tests
pnpm typecheck   # strict, noUncheckedIndexedAccess
pnpm eval        # run the example suite
pnpm build
```

The source is about 4,000 lines. The comments explain reasoning rather than
syntax, so `src/eval/metrics.ts`, `src/core/partial.ts` and `src/core/store.ts`
are the fastest way to understand the design.

## License

MIT

---

All glory to God! ✝️❤️
