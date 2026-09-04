---
name: bob-app
description: Build, run, or change a personal app with Bob. Use when someone wants a tracker, log, list, checklist, or small tool for themselves; when they ask to add a field or column to one they already have; when an app file will not open; or when they ask how their data is stored.
---

# Personal apps

Someone wants a tool for themselves: a tracker, a log, a list of things with some
counts. Bob authors it once and it becomes a file they own.

**The model runs twice in an app's life.** Once to build it, once per change. Not
on open, not on add, not on edit. If you find yourself putting a model call in a
read path, you have broken the project.

## Building one

```bash
bob make "a tracker for my job applications"
```

Before running it, get the request specific enough to author well. The difference
between a good app and a bad one is almost entirely in the schema, and the schema
comes from the request.

Ask about what the person will actually type in, not about features:

- What do you want to write down each time? (these become fields)
- Is there a status or stage that changes over time? (a select field, and counts)
- What do you want to see at a glance? (metrics)

Do not ask more than two or three questions. An app is cheap to change, and
`bob change` exists precisely so the first version does not have to be right.

## Changing one

```bash
bob change job-applications "add a notes column"
```

This emits a **patch**, not a new app. Everything unmentioned stays exactly as it
was, and the person's records are untouched by construction: an edit that tries
to write into `data` is rejected outright and the record count is verified before
and after.

Say that plainly when someone hesitates to change an app they have been using.
The hesitation is reasonable and the guarantee is real.

Two things `change` cannot do on its own:

- **Add a field to the schema.** It changes the interface. If the request needs a
  new field on a record, edit the `schema.collections.<name>.fields` array in the
  file and run `bob open` to hydrate it. Existing records keep their old shape;
  nothing is deleted.
- **Touch data.** Use `bob set` / `add` / `rm`, or edit the JSON.

## Using one

```bash
bob open   <app>                  render it
bob set    <app> <field> <value>  fill in a field
bob add    <app>                  save the record
bob rm     <app> <#>              delete a record
bob list                          every app
bob log    <app>                  every change, with what was asked
```

All of these are local and instant. Add `--in <collection>` for an app with more
than one list; with one list it is inferred.

## The file

One JSON file in `~/.bob/apps`, or `BOB_WORKSPACE`. Four parts:

| Part      | What it is                           | Changed by               |
| --------- | ------------------------------------ | ------------------------ |
| `schema`  | what a record is                     | you, by hand             |
| `view`    | the interface, bound by JSON Pointer | `bob change`             |
| `data`    | their records                        | `bob set` / `add` / `rm` |
| `history` | every change, as ops                 | appended, never edited   |

Keeping data out of the view is the whole reason an app can be restyled after a
year without risking the year. Reading or editing the JSON directly is fine and
expected: it is their file.

`history` stores ops rather than replacements, so any earlier view can be rebuilt
exactly with `viewAtRevision`. That only works for apps `bob make` authored,
because a hand-assembled app has no creation entry to replay onto, and it fails
loudly rather than returning a blank view.

## In React

```tsx
import { BobApp, BobProvider } from "bobthebuilder/react";
import { loadApp } from "bobthebuilder/app";

<BobProvider>
  <BobApp app={app} onChange={setApp} onMessage={toast} />
</BobProvider>
```

Ships unstyled semantic defaults so it renders immediately; pass `components` to
replace any of them. `onChange` hands back the updated app and persisting is the
caller's job, so the same component works against a file, IndexedDB, or a sync
engine.

## Configuring a model

`BOB_MODEL_CMD` is any command that reads a prompt on stdin and writes the answer
to stdout, so Bob ships no SDK and holds no key:

```bash
export BOB_MODEL_CMD='claude -p'
export BOB_MODEL_CMD='llm -m gpt-4o'
export BOB_MODEL_CMD='ollama run llama3'
```

## Things that will come up

**"Can I have two apps with the same name?"** Yes. `bob make` never overwrites an
existing app; it builds the new one under a free name and says so. `--force`
replaces and loses the records, and should be rare enough to feel deliberate.

**"Where did my data go?"** Nowhere. `bob list` shows the workspace path, and the
file is plain JSON.

**"Can two people use one app?"** Not safely. Writes are read-modify-write with
no locking, so simultaneous edits from two processes can lose one of them. It is
single-player by design; the file being plain JSON means somebody else's sync
tool can own that problem.

**"Will this still work if the project dies?"** The data is legible JSON and the
schema is in the same file. That is the point.
