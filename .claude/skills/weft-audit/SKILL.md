---
name: weft-audit
description: Audit a Weft catalog and validate captured model output. Use before shipping a generative UI, when setting up CI for one, when generated interfaces have accessibility or quality problems, or when deciding whether a wire format is costing too much.
---

# Auditing generative UI

The premise: **test the artifact, never the rationale.** A 2026 benchmark of five
leading generative UI tools measured whether their stated design reasoning
appeared in what they actually built. Over a quarter of it did not, and on
functional UX principles four of the five implemented six percent or fewer. A
model's account of its own output is not evidence.

## The three checks

```bash
npx weft audit  <catalog>            # the catalog, before anything renders
npx weft check  <catalog> <fixture>  # captured model output
npx weft tokens <catalog> <fixture>  # what the wire format costs
```

`audit` and `check` exit non-zero on errors, so both drop into CI as they are.

## Why the catalog is the audit surface

A catalog has a fixed number of components and they are the same ones on every
request, so checking a component once checks every interface that will ever be
built from it. Auditing generated HTML means auditing an artifact that did not
exist a second ago and will never exist again.

This is the only tractable point of leverage, and nothing else in this ecosystem
does it.

### Errors `audit` reports

- `interactive-needs-name` an operable role with no accessible name source. This
  is the "button labelled button" failure that shows up in every audit of
  generated interfaces.
- `interactive-needs-keyboard` an operable role declaring `keyboard: false`
- `role-needs-name` a role like `img` or `table` that must carry a name
- `name-prop-missing` the accessible name points at a prop the schema lacks

### Warnings worth fixing

- `no-skeleton` no declared placeholder, so it cannot inherit its own typography
- `thin-description` too short for a model to choose the component reliably
- `catalog-no-live` nothing in the catalog can announce a result at all
- `keyboard-undeclared` interactive and silent about keyboard support

## Fixtures

Capture real model output and commit it. This is the part teams skip and the part
that catches regressions.

```bash
# Save the raw stream your model produced
cat > examples/fixtures/quarterly-report.wl
```

`check` catches:

- `dangling-child` a child id referenced but never declared, so a skeleton sits
  where content should be
- `cycle` a component that is its own ancestor. The renderer cuts it, so part of
  the surface silently disappears
- `unreachable` declared but not reachable from the root: tokens spent for nothing
- `missing-accessible-name` a component whose name prop arrived empty
- `placeholder-content` lorem ipsum, "Item 1", TODO, "your text here", foo/bar

Placeholder content is a real failure and not a cosmetic one. A user cannot tell
filler from an answer in a generated interface, because they do not already know
what the answer should be.

## Token cost

```
$ npx weft tokens examples/catalog.ts examples/fixtures/report.wl

  format   tokens    bytes    ratio    seconds @ 60 tok/s
✓ lines     292      799     1.00×       4.9s
  jsonl     723     1666     2.48×      12.1s
  json      673     2242     2.30×      11.2s
```

Counts are heuristic, within roughly 10% on structured text. **The ratio is the
durable number**, because formats differ mostly in punctuation density and every
tokenizer charges for punctuation. For exact figures pass your model's tokenizer:

```ts
import { auditTokens } from "weft/audit";
auditTokens("scenario", ops, { count: (t) => tokenizer.encode(t).length });
```

## CI

```yaml
- run: npx weft audit src/catalog.ts
- run: |
    for f in fixtures/*.wl; do
      npx weft check src/catalog.ts "$f" || exit 1
    done
```

## What this does not check

Say this plainly rather than letting a green run imply more than it means.

- **Nothing rendered.** These checks run against the catalog and the spec, not the
  DOM. They cannot tell you a component honours the `a11y` it declared.
- **No aesthetics.** The best available automated metric for generated interface
  quality agrees with human annotators about 69% of the time, which is usable for
  regression and too weak to gate a build.
- **No substitute for a screen reader.** Tab through a generated surface and
  listen to it. The audit makes a class of failure impossible to ship; it does not
  make the result good.
