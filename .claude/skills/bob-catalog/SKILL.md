---
name: bob-catalog
description: Design or extend a Bob component catalog. Use when the user wants to add a component the model can generate, start a new catalog, adapt an existing design system into one, or when generated interfaces keep reaching for something that does not exist.
---

# Designing a catalog

The catalog is the toolbox: everything Bob is allowed to build with. A good one
produces good interfaces from a mediocre model; a bad one cannot be rescued by a
good model. This is where nearly all the leverage is.

## Before adding anything

Ask what the model actually reached for. Add a component because you watched a
generation want something that did not exist, never in anticipation. **Eight good
components beat forty**, because the model has to choose and every near-duplicate
makes the choice worse.

If the user is adapting an existing design system, do not port it one for one.
Pick the eight to twelve components that cover the shapes their answers actually
take, and leave the rest out until something demands them.

## The shape

```ts
import { z } from "zod";
import { defineComponent } from "bobthebuilder";

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
})
```

Each field earns its place:

**`props`** Zod, and it does double duty as the contract sent to the model and
the runtime guard. Constrain tightly: `z.enum` over `z.string` wherever the set is
known, `.min(1)` on anything that becomes an accessible name.

**`describe`** Functional text, not documentation. It is what the model reads to
choose. Say what the component is for **and when to pick it over its nearest
neighbour**. If two components have descriptions that could be swapped without
anyone noticing, the model cannot tell them apart either.

**`a11y`** Not decoration. This is what makes the component auditable once instead
of auditing generated output forever.

- `role` the ARIA role you actually render, not the one you meant
- `name` where the accessible name comes from. Interactive roles must not be
  `{ from: "none" }`
- `keyboard: true` required for interactive roles, and it has to be true in the
  React component too
- `live` for anything reporting status or results. `"polite"` almost always;
  `"assertive"` interrupts and is for errors only

**`skeleton`** `{ shape: "text", lines: n }` for prose, `{ shape: "block" }` for a
box, `{ shape: "none" }` for a container. Containers have no ink of their own, so
drawing a box for one invents a shape the real component never had.

**`children`** Omit to allow anything, `[]` for a leaf, or list the allowed
component names. Listing them lets the store catch bad composition.

**`examples`** Two realistic ones. These move generation quality more than any
prose in the prompt. Write them in Bob Lines, with real content: never
placeholders, never "Item 1".

## After writing it

```bash
npx bob audit path/to/catalog.ts
```

Fix every error. Warnings are usually worth fixing too: `no-skeleton` and
`thin-description` both directly degrade output quality.

Then check the prompt the catalog produces, because that is what the model
actually sees:

```bash
npx bob prompt path/to/catalog.ts
```

If a component's entry reads ambiguously to you, it reads ambiguously to the
model.

## Common mistakes

- **A component per visual variant.** `PrimaryButton` and `SecondaryButton` should
  be one `Button` with a `variant` enum. The model picks better from fewer options.
- **Deep nesting.** Prefer fewer, larger components. Depth costs tokens and gives
  the user nothing.
- **Loose props.** `z.string()` where `z.enum(["info","warning","error"])` is
  correct hands the model a way to be wrong.
- **A catalog with nothing live.** If no component declares `a11y.live`, nothing
  in the catalog can announce a result to a screen reader user. The audit warns.
- **Forgetting the React component.** Every catalog entry needs an entry in the
  `ComponentMap` passed to `BobSurface`, and it must honour what `a11y` promised.
