# What this is built on

Every non-obvious decision in Weft traces to something below. Where a claim is
weak or a source has an interest in the result, that is said rather than hidden,
because a library that cites a vendor benchmark as though it were neutral is
doing the same thing the Design Theater paper is about.

Research current as of September 2026.

---

## The wire format is a flat map with a named root

Google's **A2UI** (`a2ui-project/a2ui`, Apache-2.0) and Vercel's **json-render**
(`vercel-labs/json-render`, Apache-2.0) were built independently by different
teams with different priorities. Both landed on a flat map of components keyed by
id with a named root, rather than a nested tree.

A2UI:

```json
{"updateComponents":{"components":[{"id":"root","component":"Card","child":"form"}]}}
```

json-render:

```json
{"root":"card-1","elements":{"card-1":{"type":"Card","props":{},"children":["button-1"]}}}
```

The reason is the same in both cases: a nested tree cannot be patched or streamed
out of order, and a flat map can. When two independent teams converge on a data
structure, the structure is usually right.

**In Weft:** `src/core/spec.ts`.

## Data is separate from components, addressed by JSON Pointer

A2UI keeps the data model separate from the component graph, with `updateDataModel`
patching a JSON Pointer path under upsert semantics: create if missing, replace if
present, delete on null. This lets a value change without touching the graph and a
component be replaced without losing its value.

**In Weft:** `src/core/pointer.ts`, and `$bind` in `src/core/spec.ts`.

## Nothing renders before the root resolves

A2UI: a surface does not render until a component with `"id": "root"` arrives.
Without this, a surface flashes a partially built tree on the way to being
correct, and users read that flash as a defect rather than as progress.

**In Weft:** the root gate in `src/core/store.ts`, tested in `test/store.test.ts`.

## A value is invisible until it is closed

A standard JSON parser can do nothing with `{"total": 12` until more arrives, so a
naively streamed structured response shows a blank screen and then everything at
once. The fix is partial parsing, and the constraint on partial parsing is that
`12` might be the first half of `1200`.

Prior art: `langdiff` (`globalaiplatform/langdiff`), `partial-json-parser`,
`json-streamer`. The consistent advice across all of them is to use a maintained
parser rather than writing one, and to refuse to render a scalar until it is
closed.

Weft writes one anyway, for two reasons: a UI library taking a parser dependency
in its render path is a poor trade, and the closed-scalar rule needs to be
enforced identically across three wire formats. It is about 120 lines and
`test/partial.test.ts` walks every prefix of a document asserting that no visible
scalar ever differs from its final value.

The line-oriented format gets the same guarantee for free, which is the better
argument for it and the one nobody makes: a line is either complete or invisible,
so there is no partial-value state to get wrong.

**In Weft:** `src/core/partial.ts`, `src/core/lines.ts`.

## Wire format is a first-order cost

OpenUI published a seven-scenario benchmark across formats:

| Format         | Tokens | Relative |
| -------------- | ------ | -------- |
| OpenUI Lang    | 4,800  | baseline |
| YAML           | 9,122  | +90%     |
| Legacy C1 JSON | 9,948  | +107%    |
| json-render    | 10,180 | +112%    |

At 60 tokens/second they report a contact form at 4.9 seconds against 14.9, a
3.04x difference, and open-ended HTML generation at 5 to 10x the tokens of an
equivalent declarative spec.

**Caveat, stated plainly: OpenUI published this and OpenUI Lang wins it.** The
mechanism is real and verifiable by counting punctuation, but the multiplier is
theirs and was measured on their scenarios.

So Weft ships `weft tokens`, which measures the spread on your catalog and your
fixtures. On this repo's example fixture it reports 2.48x, which is the same
direction and a smaller magnitude than the published figure. That is roughly what
you would expect from an independent scenario, and it is why the tool exists
rather than a citation.

**In Weft:** `src/audit/tokens.ts`.

## Production cost figures

From reported deployments, for calibrating the escape hatch:

- Full-page HTML regeneration: **one to five minutes per page, roughly 220,000
  tokens per session** without caching.
- Reducing output from ~2,000 tokens to ~30 cuts cost **100x or more**. The lever
  is emitting a component reference instead of a component.
- One team reported generated UI served at **under 200ms**, via caching plus
  regeneration only on first visit.
- Amazon's Alexa Plus needed multi-model routing, prompt caching, and speculative
  execution to hold **sub-2-second** latency.

**In Weft:** the cost notes in `src/react/sandbox.tsx`, and the guidance in
`CLAUDE.md` to keep open-ended generation to one subtree.

## An iframe with allow-scripts and allow-same-origin is not sandboxed

Together those two flags let the framed script reach the parent DOM or remove its
own `sandbox` attribute. Each looks individually reasonable, which is why the
combination appears constantly in tutorials.

A2UI's double-iframe isolation pattern:

- **Outer frame**: same origin as the host, not sandboxed, acts as a message relay
  and validates message origin.
- **Inner frame**: `sandbox="allow-scripts allow-forms allow-popups allow-modals"`,
  deliberately without `allow-same-origin`, `allow-top-navigation`, or
  `allow-top-navigation-by-user-activation`.

Dropping `allow-same-origin` gives the frame an opaque origin, which also cuts it
off from cookies, `localStorage`, `sessionStorage`, and IndexedDB. Dropping the
top-navigation flags kills frame-busting and popup-based exfiltration.

MCP Apps (SEP-1865, spec stable January 2026, Anthropic and OpenAI jointly)
mandates the same shape: sandboxed iframes, pre-declared templates the host can
review, server-declared CSP enforced by the host, and auditable JSON-RPC. OpenAI's
`window.openai` bridge in ChatGPT is this mechanism with a compatibility layer.

**In Weft:** `src/react/sandbox.tsx`. The security is in what is absent.

## Screen readers ignore live regions injected after load

Several screen readers subscribe to `aria-live` regions at page load and never
notice one added later. Streaming generative UI injects everything dynamically, so
the default behaviour of a streamed interface is that a screen reader user is told
nothing as content arrives, and the smoother the streaming looks, the more
completely it fails.

The fix is to mount the regions once, empty, at the app root and stream text into
them. That has to be structural or it will not survive a deadline, which is why
`WeftProvider` renders them unconditionally and warns in development when a surface
renders outside it.

Related failures worth auditing for: `aria-hidden` on a container that holds form
inputs, and validation errors that never reach the accessibility tree.

The optimistic case is real too. WCAG regulates developer behaviour; generative UI
operates on the rendered experience and adapts at the point of consumption.
Research on C2C e-commerce (arXiv 2604.25455) found the familiar gap: pages
passing automated audits while still failing real users, with WCAG pass rates
correlating poorly with what a screen reader actually announces. See also arXiv
2601.06616 on model-based accessible interface generation.

**In Weft:** `src/react/live-region.tsx`, `src/audit/a11y.ts`.

## The catalog is the only tractable audit surface

A catalog has a fixed number of components and they are the same ones on every
request, so auditing a component once audits every interface built from it.
Auditing generated HTML means auditing an artifact that did not exist a second ago
and will never exist again.

Nothing in the surveyed ecosystem does this. It was the clearest gap in the field
and it is the reason `weft audit` exists.

**In Weft:** `src/audit/a11y.ts`.

## Design Theater: never trust a model's account of its own output

> Imteyaz, Imteyaz, Rajpal, Shaikh, Muller & Savage. *Design Theater: A Benchmark
> for Generative UI.* arXiv 2607.22928, 24 July 2026.

24 tasks across structural, styling, and functional tiers, run through ChatGPT,
Claude, Firebase Studio, Vercel v0, and Bolt, scoring whether each tool's stated
design reasoning appeared in what it built.

| Metric                | Result        | Reading                                                        |
| --------------------- | ------------- | -------------------------------------------------------------- |
| Thinking Fidelity     | 0.75 mean     | A quarter of stated reasoning is absent. Claude 0.87, Firebase 0.53 |
| By tier               | 0.79/0.81/0.66 | Structural and styling hold; functional collapses. 34% failure |
| Principle Adherence   | 0.29 – 0.73   | ChatGPT 35/48 unstated principles, Firebase 14/48              |
| Functional principles | **≤ 0.06**    | Four of five tools. Firebase scored 0.00 on every Tier 3 task  |

Their conclusion is the operative part: these tools democratize interface creation
while obscuring the evaluation bottleneck, because a persuasive design
justification substitutes for actual implementation in the eyes of anyone not
trained to tell the difference.

**In Weft:** `weft check` and `src/audit/validate.ts`. Capture real output as a
fixture and test the artifact, never the rationale.

## Evaluation is not solved

> Chen, Zhang, Zhang, Shao & Yang (Stanford). *Generative Interfaces for Language
> Models.* arXiv 2508.19227.

Proposes **GE-Score**, a VLM-judged metric across functionality, usability, visual
design, informativeness, and creativity. Generated interfaces beat chat baselines.
The number to hold onto is the validation one: **69% agreement with human
annotators.** Usable for regression testing, too weak to settle a design argument.

Adjacent: **PAGEN** (Google's expert-crafted reference set), **Design2Code**
(Stanford/Google), **StructEval**, **WebArena**, **VisualWebArena**, **GEBench**.

**In Weft:** the audit tool makes deterministic structural claims and does not
score aesthetics, because nothing available scores aesthetics reliably enough to
gate a build on.

## Placeholder content is a distinct failure

A user cannot tell filler from an answer in a generated interface, because they do
not already know what the answer should be. This is the same class of problem as
Design Theater: output that looks like it worked.

**In Weft:** `weft check` fails on lorem ipsum, numbered filler ("Item 1"),
placeholder words, fill-in-the-blank phrasing, and metasyntactic variables.

## Interruption is a feature, not an error path

Consistent findings from teams shipping agentic products through 2025 and 2026:

- Showing tool inputs and outputs as they happen is repeatedly named the single
  highest-value UX improvement.
- **Resume, do not restart.** AG-UI supports cancellation and resumption backed by
  durable execution. Early agentic apps that skipped this paid in abandonment.
- Approval prompts need accumulated context, not terse approve/deny.
- Durable, state-managed interruption with idempotency keys survives real
  infrastructure. Roughly two thirds of production agents already tolerate
  minute-plus latency, so the constraint is correctness under resume, not speed.

**In Weft:** `abort()` in `src/react/use-weft-stream.ts` keeps the rendered
surface, and a transport failure after the root arrived degrades to a warning
rather than blanking a usable surface.

## The interface question predates all of this

> Eric Horvitz. *Principles of Mixed-Initiative User Interfaces.* CHI '99,
> Microsoft Research.

Horvitz named the split we are still in: better direct manipulation, or agents
that automate? His answer was an elegant coupling of both. The Lookout system
combined machine learning, decision-making under uncertainty, speech, NLP and
dialogue, and learned user intent through what he called streaming supervision.

Every hard question in generative UI is in that paper: when to act versus wait,
how to represent uncertainty about intent, what a wrong automation costs, how the
user stays in control.

Also worth reading before forming an opinion:

- **Malleable software**, Litt, Horowitz, van Hardenberg & Matthews, Ink & Switch,
  2025. The problem is not that interfaces are static, it is that users cannot
  change them. Generative UI answers a question about agency.
- **Jelly**, Cao, Jiang & Xia (UC San Diego), CHI 2025. Argues code generation is
  the wrong foundation for malleable UI, because each prompt-based revision is a
  discontinuous transition between codebases with an opaque relationship to the
  prompt. Their alternative is a task-driven data model: object-relational schema,
  dependency graph, structured data, with edits going to the model rather than the
  output. This is the intellectual ancestor of the catalog-plus-schema approach,
  and the industry arrived at it without citing it.
- **Hidden Technical Debt in GenUI**, Besjon Cifliku, arXiv 2604.16354, CHI 2026
  workshop. Taxonomy: prompt brittleness, transparency gaps, maintenance
  complexity, agency conflicts, abstraction-layer failures, security. There is no
  `git blame` for an interface the model generated eleven sessions ago.
- **The Keyhole Effect**, arXiv 2602.00947. Chat structurally cannot support
  analysis: working memory holds three to four items and change blindness eats
  what scrolled away. Read with the Google paper it says generate the interface,
  but generate a spatial one.
- **Generative UI: LLMs are Effective UI Generators**, Leviathan et al., Google,
  arXiv 2604.09577. Generated interfaces overwhelmingly preferred to markdown, and
  comparable to human experts in about half of cases. Note the honest framing:
  the comparison that wins is against a wall of markdown text.
- **CHI 2026 workshop**, "What does Generative UI mean for HCI Practice?",
  Barcelona, 15 April 2026, ACM DL 10.1145/3772363.3778757.

---

## Claims deliberately not used

**"Streaming feels 40% faster than buffered" and "skeletons feel 20% faster than
spinners."** These appear in nearly every blog post on this subject and could not
be traced to a published controlled study. The direction is well supported and
consistent with the standard Nielsen thresholds (under 100ms instant, under 1s
preserves flow, 10s the outer edge of attention), which is why skeleton continuity
is built in. The specific percentages are not cited anywhere in this repo and
should not be put in a deck as findings.
