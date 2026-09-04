# Changelog

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
