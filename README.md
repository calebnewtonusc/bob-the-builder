# Bob-the-Builder

**Software that gets built once and stays built.**

You describe what you need. Bob builds you a real app. It is a file on your
machine, it holds your data, and from that moment on it runs with no model, no
network, and no tokens, looking exactly the same every time you open it.

When you want it different, you say so, and Bob changes that one thing.

```bash
npm install -g bobthebuilder
export BOB_MODEL_CMD='claude -p'     # or any command that reads a prompt on stdin

bob make "a tracker for my job applications"
```

```
Job applications

2  Applications
1  Interviewing
0  Offers

Every application
#    Company    Role                 Status     Applied
───  ─────────  ───────────────────  ─────────  ───────
0    Anthropic  Research Engineer    Interview
1    LEMMA      Context Engineering  Applied

Log an application
Company: —
Role: —
Status: —  [Applied / Interview / Offer / Rejected]
[ Add application ]
```

```bash
bob set job-applications company "Anthropic"
bob add job-applications
bob change job-applications "add a notes column"
```

That last command adds the column and the form field, and leaves every record
exactly where it was.

## Why this is different

Every generative UI system puts the model in the request path. You ask, it
generates, you look, it is thrown away. Ask again tomorrow and you get a
different interface.

That is why the strongest objection to generative UI has never had an answer:
**you cannot build familiarity with something that does not persist.** People
learn where things are, and a screen that rearranges itself makes them relearn
the same task forever.

Here the model is the **author, not the runtime.**

|                       | Generative UI            | Prompt-to-code (v0, Bolt)  | Bob                        |
| --------------------- | ------------------------ | -------------------------- | -------------------------- |
| Model runs when       | every view               | every revision             | first build, and edits     |
| Opening it costs      | tokens + latency         | nothing                    | nothing                    |
| Looks the same twice  | no                       | yes                        | yes                        |
| You can change it     | reprompt, get a new one  | regenerate the codebase    | patch one thing            |
| Non-developers can    | use it                   | not edit it                | edit it                    |
| Your data lives       | somewhere else           | wherever you wired it      | in the file, yours         |

The middle column is the interesting comparison. Prompt-to-code also persists,
but it generates *code*, and the CHI 2025 Jelly paper names exactly why that
breaks down: every prompt-based revision is a discontinuous jump between
codebases with an opaque relationship to what you asked, so nothing is ever
really iterated on, only replaced.

Bob edits a **patch**, in the same op format the renderer already speaks. It is
legible, revertible, and leaves everything you did not mention alone.

```bash
$ bob log job-applications

  Job applications  ~/.bob/apps/job-applications.json

  #1 A tracker with the company, role and status of every application.
      "a tracker for my job applications"
      2026-09-04 07:16 · claude · 17 op(s)
  #2 Added a notes column so you can see why each one mattered.
      "add a notes column"
      2026-09-04 07:19 · claude · 3 op(s)
```

## The file is yours

An app is one JSON file in `~/.bob/apps`. No database, no account, no sync
service, no server that has to stay up for your tracker to open. It is readable,
diffable, greppable, and backed up by whatever already backs up your home
directory.

```json
{
  "version": 1,
  "title": "Job applications",
  "schema": { "collections": { "applications": { "fields": [...] } } },
  "view":   { "root": "app", "elements": { ... } },
  "data":   { "applications": [ ... ] },
  "history": [ ... ]
}
```

Three parts, deliberately separate. **schema** is what a record is. **view** is
the interface, bound to data by JSON Pointer. **data** is yours, and an edit to
the view cannot reach it: an edit that tries to write into your records is
rejected outright, and the record count is checked before and after every change.

If this project is abandoned tomorrow, your data is still legible and still
yours. That property is worth more than any feature.

## Commands

```bash
bob make   "<what you want>"      build a new app          (uses a model)
bob change <app> "<what to fix>"  patch the interface      (uses a model)

bob open   <app>                  run it
bob set    <app> <field> <value>  fill in a field
bob add    <app>                  save the record
bob rm     <app> <#>              delete a record
bob share  <app> [file.html]      one HTML file you can send to anyone
bob list                          every app you have
bob log    <app>                  what changed and when
```

Only the first two involve a model. Everything else is local, instant, and free.

Any command that reads a prompt on stdin and writes the answer to stdout works
as the model, so Bob ships no SDK and holds no API key:

```bash
export BOB_MODEL_CMD='claude -p'
export BOB_MODEL_CMD='llm -m gpt-4o'
export BOB_MODEL_CMD='ollama run llama3'
```

## Handing it to someone

```bash
bob share job-applications
```

Writes one self-contained HTML file, about 20KB. It opens by double-clicking,
works offline, works on a phone, and can be emailed. No dependencies, no build
step, no network requests of any kind, and no model: it carries the same runtime
the terminal uses, so it behaves identically.

Changes made in the page save to that browser, and "Download your data" gets them
back as JSON, so nothing is ever trapped inside it.

## Built on measured things, not taste

Underneath the app layer is a streaming generative UI engine, and every decision
in it traces to a citation in [`docs/RESEARCH.md`](docs/RESEARCH.md).

- **The wire format is a flat map, not a tree.** Google's A2UI and Vercel's
  json-render were built independently and both landed here, because a nested
  tree cannot be patched or streamed out of order.
- **Nothing renders before the root resolves.** Claiming the root second instead
  of last moved first paint from 665ms to 29ms on an identical response, a 23×
  difference from ordering alone.
- **A value is invisible until it is closed.** `12` might still become `1200`.
- **Live regions are mounted at page load, empty.** Several screen readers ignore
  an `aria-live` region injected later, and streaming injects everything.
- **Props are allow-listed, not just validated.** Model output is spread onto
  React components, so an undeclared prop is an XSS hole, not a cosmetic problem.

## The build-time tools

If you are making your own catalog rather than using apps, three tools ship with
it, and all three exit non-zero on findings so they drop into CI as they are.

**`bob audit`** checks a catalog for accessibility before anything renders. A
catalog is finite and the same on every request, so checking one component checks
every interface ever built from it. Auditing generated HTML means auditing an
artifact that will never exist again.

**`bob check`** validates captured model output: dangling children, cycles,
unreachable components, missing accessible names, placeholder content.

**`bob eval`** runs scenarios repeatedly and measures **stability**, which is how
much the interface moves across runs of the same prompt:

```
✗ comparison becomes a table, not prose
  stability  ████████░░░░ 0.68  (min 0.8)
    2 distinct layouts across 3 runs:
      2× Stack(Heading,Table)
      1× Stack(Heading,Text,Table)
  ✓ renders 3/3    ✓ uses Table 3/3    ✓ no placeholders 3/3
```

Every assertion passed and the scenario still failed. That number is what the
app layer makes unnecessary: an app that is authored once and read from a file
scores 1.00 by construction, because it is not being generated at all.

## Library use

```bash
npm install bobthebuilder zod
```

- `bobthebuilder` — catalogs, streaming, the wire format
- `bobthebuilder/app` — app files, the runtime, authoring and editing
- `bobthebuilder/react` — `BobProvider`, `BobSurface`, `useBobStream`
- `bobthebuilder/eval` — scenarios, stability, baselines
- `bobthebuilder/audit` — accessibility and validation

```ts
import { loadApp, applyAction, renderApp } from "bobthebuilder/app";

const app = await loadApp("job-applications");
const { app: next } = applyAction(app, { type: "add", collection: "applications" });
console.log(renderApp(next));
```

In React, `BobApp` renders an app file with no model and no streaming, and ships
unstyled semantic defaults so it works on import:

```tsx
import { BobApp, BobProvider } from "bobthebuilder/react";

<BobProvider>
  <BobApp app={app} onChange={setApp} onMessage={toast} />
</BobProvider>
```

## Using this with Claude Code

Drop the repo in and [`CLAUDE.md`](CLAUDE.md) is the operating manual. Skills in
[`.claude/skills/`](.claude/skills/) cover building a catalog, wiring a model,
auditing, and writing evals.

## What this is not

- **Not a general app builder.** Bob makes the kind of thing a person builds for
  themselves: a list of things, a form, some counts. It does not make Figma.
- **Not multiplayer.** One file, one person. Sync is somebody else's problem, and
  the file being plain JSON means it can be theirs.
- **Not multiplayer.** One app, one person. Writes take an exclusive lock so two
  processes cannot corrupt a file, but there is no merge and no sync. The file
  being plain JSON means somebody else's sync tool can own that problem.
- **Not an app store.** `bob share` produces a file, not a hosted thing with a
  URL and accounts.
- **Not aesthetic judgement.** The eval harness makes structural claims only. The
  best published judge for whether a generated interface is *good* agrees with
  humans 69% of the time, which is too weak to gate anything on.

## Development

```bash
pnpm install
pnpm test        # 232 tests
pnpm typecheck   # strict, noUncheckedIndexedAccess
pnpm build

BOB_WORKSPACE=/tmp/bob-demo pnpm demo:app make "a reading log" --adapter examples/demo-adapter.ts
```

`src/app/format.ts` explains the thesis, `src/app/runtime.ts` is everything that
happens without a model, and `src/app/author.ts` is the only place one is used.

## License

MIT

---

All glory to God! ✝️❤️
