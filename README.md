# Bob The Builder

**Streaming generative UI for TypeScript. You stock the toolbox, the model builds with it.**

The model does not write code and does not write HTML. It picks components from a
catalog you defined and gives them content, and a renderer draws them as they
arrive. Bob can only build with what you put in the toolbox, so it does not matter
how creative the model gets: the parts were approved before it started.

```bash
npm install bobthebuilder zod
```

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
    // ...
  },
});
```

```tsx
import { useBobStream, BobProvider, BobSurface } from "bobthebuilder/react";

function Report({ question }: { question: string }) {
  const { spec, ready, status, start, abort } = useBobStream({ catalog });

  return (
    <BobProvider>
      <button onClick={() => start(streamFromYourModel(question))}>Ask</button>
      {status === "streaming" && <button onClick={abort}>Stop</button>}
      <BobSurface
        spec={spec}
        catalog={catalog}
        components={componentMap}
        ready={ready}
      />
    </BobProvider>
  );
}
```

The system prompt is generated from the catalog, so it cannot drift from it:

```ts
const system = buildSystemPrompt(catalog, { format: "lines", task: question });
```

## Why this exists

Generative UI has a large gap between what the framework blogs claim and what the
research measures. Bob is an attempt to build the version that takes the
measurements seriously. Every design decision below traces to something in
[`docs/RESEARCH.md`](docs/RESEARCH.md), with citations.

**The wire format is a flat map, not a tree.** Google's A2UI and Vercel's
json-render were built independently and both landed here. A nested tree cannot be
patched or streamed out of order; a flat map can. A child may arrive before its
parent and nothing special has to happen.

**Nothing renders before the root resolves.** A surface that flashes a half-built
tree on its way to being correct reads as a bug rather than as progress.

**A value is invisible until it is closed.** `12` might still become `1200`.
Showing a wrong number for 40 milliseconds is worse than showing nothing, because
a user cannot tell a value that changed from a value that was never true. The
default wire format enforces this with a newline; the JSON parser enforces it by
tracking what has actually finished arriving.

**Live regions are mounted at page load, empty.** Several screen readers ignore an
`aria-live` region that was injected later, and streaming generative UI injects
everything. This is the failure mode where the smoother your interface looks, the
more completely it fails for anyone not watching it. `BobProvider` makes it
structural instead of a thing you remember.

**The catalog is the audit surface.** A catalog has maybe thirty components and
they are the same thirty on every request, so checking one component checks every
interface that will ever be built from it. Auditing generated HTML means auditing
an artifact that will never exist again.

## Watch it stream

`pnpm demo` streams a response one character at a time and prints the surface
assembling, no browser needed:

```
[ready]   root resolved after 29ms
[pending] skeletons for: title, summary, metrics, table
[pending] skeletons for: summary, metrics, table
[pending] skeletons for: metrics, table
[pending] skeletons for: table, m_rev, m_deals
[pending] skeletons for: table
[done]    662ms total, 9 paints
```

That first number is the whole argument for the ordering the generated prompt
asks for. The model declares the root component, then claims it with `r`, then
sends everything else. Nothing can paint until `r` arrives, so putting it second
gets a surface on screen in 29ms and fills it in.

Emitting `r` last, which is what a model reaches for unprompted, gives you one
paint at 665ms: a **23x** worse time to first paint on the identical response.
Both orders are locked in by tests in `test/store.test.ts`.

## The audit tool

`bob audit` is the piece nothing else in this ecosystem has. It checks the
catalog before anything renders.

```
$ npx bob audit examples/catalog.ts

starter · 9 components, 3 actions
  No findings.

clean
```

```
$ npx bob check examples/catalog.ts examples/fixtures/report.bl

examples/fixtures/report.bl · 14 operations
  No findings.

  10 components reachable from root

clean
```

`check` runs against captured model output. It catches dangling children, cycles,
unreachable components, missing accessible names, and placeholder content, and it
exits non-zero, so it drops into CI as it is.

This matters because of one specific finding. A 2026 benchmark of five leading
generative UI tools measured whether their stated design reasoning appeared in
what they actually built: over a quarter of it did not, and on functional UX
principles four of the five implemented six percent or fewer. **The reasoning
trace is not evidence.** Capture real output as a fixture and test the artifact.

## Token cost, measured on your catalog

Wire format is a recurring bill and a latency floor, not a style preference.

```
$ npx bob tokens examples/catalog.ts examples/fixtures/report.bl

Wire format cost · examples/fixtures/report.bl

  format   tokens    bytes    ratio    seconds @ 60 tok/s
✓ lines     292      799     1.00×       4.9s
  jsonl     723     1666     2.48×      12.1s
  json      673     2242     2.30×      11.2s

  2.48× spread between cheapest and priciest.
```

The published benchmark everyone cites for this was run by a vendor whose own
format won it. The mechanism is real and you can verify it by counting
punctuation, but the multiplier is theirs and was measured on their scenarios.
This measures yours. Pass your model's tokenizer to `auditTokens({ count })` for
exact figures rather than the built-in estimate.

## Wire formats

| Format  | Shape                        | Use when                                          |
| ------- | ---------------------------- | ------------------------------------------------- |
| `lines` | `c hero Metric label="…"`    | Default. Cheapest, and stream-safe by construction |
| `jsonl` | One JSON op per line         | Something downstream already speaks JSON objects    |
| `json`  | One streamed Spec object     | Structured output pins the model to a JSON schema   |

Bob Lines is four verbs:

```
c <id> <Type> [prop=value ...]     declare a component
> <id> <child> [child ...]         give it children
d <pointer> <json>                 patch the data model
r <id>                             declare the root
```

```
c page Stack gap=4
> page title metrics
c title Heading text="Q3 revenue by region" level=1
c metrics Metric label="Total revenue" value=@/totals/revenue delta=12.4
d /totals/revenue 4820000
r page
```

`@/pointer` binds a prop to the data model, so a value can update without
rebuilding the component. `!action` references a catalog action.

## The escape hatch

`BobSandbox` renders model-authored HTML for the one subtree that genuinely
needs it. It exists mostly so you do not write the iframe yourself:

```tsx
<BobSandbox html={generated} title="Custom chart" />
```

An iframe carrying both `allow-scripts` and `allow-same-origin` **is not
sandboxed**. Together they let the framed script reach the parent document or
remove its own `sandbox` attribute. That combination appears constantly in
tutorials because each flag looks individually reasonable, and it is the most
common serious mistake in this field. `BobSandbox` omits `allow-same-origin` and
both top-navigation flags by construction.

Use it inside a catalog-rendered page, never as the page. Open-ended generation
runs several times the tokens of the same screen declared through a catalog, and
nothing inside it is auditable.

## API

**`bobthebuilder`**

`defineCatalog` `defineComponent` `defineAction` · `BobStream` `SurfaceStore`
`resolveProps` · `buildSystemPrompt` · `LineBuffer` `parseLines` `serializeLines`
· `parsePartialJson` `PartialJsonStream` · `getAt` `setAt` `parsePointer`

**`bobthebuilder/react`**

`BobProvider` `BobSurface` `useBobStream` `useAnnouncer` `BobSkeleton`
`BobSandbox`

**`bobthebuilder/audit`**

`auditA11y` `validateOps` `auditTokens` `estimateTokens` `serializeAs`

## Using this with Claude Code

Drop the repo in and [`CLAUDE.md`](CLAUDE.md) teaches the agent the whole model:
the pattern decision, how to write a catalog, which format to pick, and the rules
that come from measurement rather than taste. Three skills in
[`.claude/skills/`](.claude/skills/) cover building a catalog, wiring a model, and
auditing what comes back.

## What this does not do

Said plainly, because the alternative is you finding out later.

- **Voice.** LiveKit Agents handles realtime voice well. Joining it to streaming
  generative UI is an open problem and this does not solve it.
- **Flutter, Lit, Angular, native mobile.** Bob renders React. Google's A2UI has
  official renderers for all of those plus a native C++ one.
- **An agent runtime.** Bring your own. Bob takes an async iterable of strings
  and does not care where it came from.
- **Constrained tool-call UI.** If the answer always has one of three shapes, use
  ordinary tool calling. You do not need this.

## Development

```bash
pnpm install
pnpm test        # 65 tests, mostly on streaming edge cases
pnpm typecheck   # strict, noUncheckedIndexedAccess
pnpm build
```

The source is about 2,000 lines. The comments explain reasoning rather than
syntax, so reading `src/core/partial.ts` and `src/core/store.ts` is the fastest
way to understand the design.

## License

MIT

---

All glory to God! ✝️❤️
