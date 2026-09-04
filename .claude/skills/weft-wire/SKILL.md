---
name: weft-wire
description: Wire a model to a Weft surface. Use when connecting an LLM, agent, or transport to a catalog, choosing a wire format, building the system prompt, or handling streaming, interruption, and actions in React.
---

# Wiring a model to a surface

Weft takes an async iterable of strings and does not care where it came from. Any
model, any transport.

## Server: build the prompt from the catalog

```ts
import { buildSystemPrompt } from "weft";

const system = buildSystemPrompt(catalog, {
  format: "lines",
  task: userQuestion,
});
```

**Never hand-write this prompt.** It drifts from the catalog the first time
someone adds a component, and the failure is silent: the model keeps emitting a
component that no longer exists and the store keeps dropping it.

Then stream the model's text back to the client however you already do. Weft does
not own the transport.

## Client: the hook

```tsx
import { useWeftStream, WeftProvider, WeftSurface } from "weft/react";

function Answer({ question }: { question: string }) {
  const { spec, ready, status, warnings, error, start, abort } = useWeftStream({
    catalog,
    onAction: (name, payload) => runAction(name, payload),
  });

  return (
    <WeftProvider>
      <button onClick={() => start(streamText(question))}>Ask</button>
      {status === "streaming" && <button onClick={abort}>Stop</button>}
      {error && <ErrorState message={error} />}
      <WeftSurface
        spec={spec}
        catalog={catalog}
        components={componentMap}
        ready={ready}
        onAction={runAction}
        fallback={<Thinking />}
      />
    </WeftProvider>
  );
}
```

`WeftProvider` must wrap the app root, not sit next to the surface. It mounts the
live regions at page load, and several screen readers ignore an `aria-live` region
injected later. A surface rendered outside it warns in development.

## Choosing a format

| Format  | Use when                                                        |
| ------- | --------------------------------------------------------------- |
| `lines` | Default. Cheapest, and stream-safe because a line is atomic      |
| `jsonl` | Something downstream already speaks JSON objects                  |
| `json`  | Structured output constraints pin the model to a JSON schema      |

This is a recurring bill and a latency floor, not a style choice. Measure it:

```bash
npx weft tokens <catalog> <fixture>
```

## The component map

Each catalog entry needs a React component. It receives its resolved props plus
`onAction`, `onChange`, and `children`.

```tsx
const componentMap = {
  Metric: ({ label, value, delta }) => (
    <div role="group" aria-label={String(label)}>…</div>
  ),
  Button: ({ label, action, onAction }) => (
    <button onClick={() => onAction(String(action))}>{label}</button>
  ),
  Field: ({ label, value, onChange }) => (
    <label>
      {label}
      <input value={String(value ?? "")} onChange={(e) => onChange("value", e.target.value)} />
    </label>
  ),
};
```

The component must honour what the catalog's `a11y` promised. The audit checks the
declaration; only you can make the component match it.

## Bindings and actions

`@/pointer` in a prop binds it to the data model. Bindings resolve at render time,
so a `d` op updates the value without rebuilding the component. `onChange(prop, value)`
writes back through the binding, and is a no-op with a development warning on an
unbound prop.

`!action` references a catalog action. `onAction` fires only for actions the
catalog declares.

## Interruption

`abort()` stops the stream and keeps everything already rendered. Do not replace
it with a reset. A user who interrupts should keep what they have, and teams
shipping agentic products consistently report resume-not-restart as the difference
between a tool people keep and one they abandon.

A transport failure after the root arrived degrades to a warning and leaves the
surface up, rather than blanking something usable.

## Strict versus lenient

Default is `lenient`: one bad component out of thirty degrades a card, not the
screen. Use `mode: "strict"` in tests and CI, where a dropped component should
fail loudly.

## What to check before shipping

1. `npx weft audit <catalog>` clean
2. Capture real model output to `examples/fixtures/*.wl` and run
   `npx weft check <catalog> <fixture>` in CI
3. Confirm the first paint is the skeleton and not a layout jump
4. Tab through a generated surface, then listen to it with a screen reader
