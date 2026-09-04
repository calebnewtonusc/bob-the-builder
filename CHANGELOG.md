# Changelog

## 0.3.1

Fixes from auditing the app layer.

- **`bob make` destroyed an existing app with a matching title, records and
  all.** The single thing the project promises cannot happen. It now builds
  under a free name and says so; `--force` is required to replace one.
- **`BobApp` did not exist**, despite the README implying a React renderer. It
  now ships, with unstyled semantic defaults, and is tested.
- **A bound input in a non-streaming surface silently discarded every edit**,
  because `BobSurface` could only write back through a streaming store. Added
  `onWrite`, and a development warning when a surface has nowhere to write.
- **`bob set` / `add` / `rm` only ever touched the first collection**, so an app
  with two lists could only use one. Added `--in`, and an error rather than a
  guess when it is ambiguous.
- CI now runs the full app lifecycle: build, use, change, verify records
  survived, verify two opens are byte-identical, verify a rebuild does not
  overwrite.
- Added the `bob-app` skill, and `docs/RESEARCH.md` now explains why the model
  authors instead of renders.

197 tests, up from 189.

## 0.3.0

The model is now the author, not the runtime.

Every generative UI system, including the previous version of this one, put a
model in the request path: ask, generate, look, discard. That is why the
muscle-memory objection to generative UI has never had an answer, because you
cannot build familiarity with something that does not persist.

### Added

- **`bob make`** authors an app once, from a plain-language description, and
  writes it to a file you own. Opening it after that costs no model call, no
  network, and no tokens, and renders identically every time.
- **`bob change`** patches an app. Edits are ops, not replacements, so they are
  legible, revertible, and leave everything unmentioned alone. An edit that tries
  to write into your records is rejected, and the record count is verified before
  and after.
- **`bob open` / `set` / `add` / `rm` / `list` / `log`**, all local and instant.
- App files: one JSON file per app holding `schema`, `view`, `data` and
  `history`, in `~/.bob/apps`. No database, no account, no server.
- A built-in `personal` catalog of twelve components, which passes the project's
  own accessibility audit.
- Computed props: `{"$count": "/rows"}` and `{"$sum": "/rows", "field": "x"}`, so
  totals stay true instead of being typed once and going stale.
- A terminal renderer, which is how the no-model claim is checkable rather than
  asserted.
- `bobthebuilder/app` export.

### Fixed

- Computed props were validated as literals and rejected by their own schema,
  found by running the demo rather than by reading the code.
- `viewAtRevision` silently returned an empty op list for an app whose history
  did not include its creation, which would look like a successful revert to a
  blank view. It now fails loudly.

## 0.2.0

### Added

- **`bob eval`**, an eval harness for generated interfaces, and **stability**, a
  metric measuring how much an interface moves across runs of the same prompt.
  A scenario can fail with every assertion passing, which is the point: a model
  that produces a correct but different interface each time is the failure users
  actually complain about, and no assertion-only tool can express it. Baselines
  gate stability, cost, first paint, and assertions in CI.
- `replayAdapter` so the deterministic half of a suite runs offline with no key.
- `ComponentMap<typeof catalog.components>` types each React component against
  the schema its catalog entry declared.
- CI workflow, coverage config, `bobthebuilder/eval` export.

### Fixed

- **Props are now allow-listed, not just validated.** Validation ran and its
  stripped output was discarded, so any prop the model invented flowed through
  to a React component. Model-supplied `dangerouslySetInnerHTML` reached the DOM.
- **Renderer cycle detection is path-scoped.** A spec-scoped set was mutated
  during render, so React's development double-render drew nothing, and a
  legitimate DAG lost every repeat of a shared child.
- **A malformed line no longer kills a lenient stream.** The parser threw before
  the store's lenient path could see it, making the mode decorative.
- **JSONL keeps a trailing line with no newline.** `close()` flushed only the
  `lines` format, silently dropping the final op, usually `root`.
- **Data patches are bounded.** `d /rows/5000000/x 1` allocated a five-million
  entry array from one line of model output.
- `__`-prefixed ids are reserved so a model cannot collide with internal sentinels.
- Skeleton shimmer animated between two identical colours and was invisible.
- `finish()` could emit `done` twice; `write()` never recomputed pending children.
- Removed the unused `Action` type and an unreachable branch in `setAt`.
- Corrected stale counts and a stale package path in the docs.

## 0.1.0

Initial release as Weft, renamed to Bob-the-Builder.
