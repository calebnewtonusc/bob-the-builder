/**
 * The HUD's vocabulary, in one place.
 *
 * This file exists because of a rule in this repo's own operating manual that I
 * broke while building the HUD: *never hand-write the system prompt, because it
 * drifts from the catalog the first time somebody adds a component, and the
 * failure is silent.* The renderer drops what it does not recognise, so a
 * documented component that no longer exists produces a panel that is quietly
 * missing a piece and tells nobody.
 *
 * The HUD's vocabulary had been written by hand, in two places, in prose. This
 * is the single source it should have come from. `scripts/gen-hud-docs.ts`
 * regenerates the documentation from here, so the two copies can no longer
 * disagree with the renderer or with each other.
 *
 * The prop schemas are the same contract the Swift side enforces. They are not
 * executed by the HUD, which is a separate process in a different language, so
 * they cannot drift into being load-bearing. They are here to be read by a
 * model and checked by `bob audit`.
 */

import { z } from "zod";
import { defineCatalog, defineComponent } from "../core/catalog.js";

/** A tone name. Four, and no free-form colour: see `Bars` for why. */
const tone = z.enum(["good", "warn", "bad"]).optional();

/** A value that has earned a colour by crossing a line. */
const thresholds = z
  .array(z.object({ at: z.number(), tone: z.enum(["good", "warn", "bad"]) }))
  .optional();

export const hudCatalog = defineCatalog({
  name: "hud",
  guidance: `
Every line is one op, and a line is either complete or invisible, so a
half-written line never draws a half-built panel. Nothing paints until \`r\`.

Write arrays with no spaces inside them: the parser splits on whitespace, so
\`points=[31,28,44]\` works and \`points=[31, 28, 44]\` does not.

Bind with \`@/pointer\` and then push data, for anything that updates more than
once. The component goes out once and each update after is one short line.

Do not restate the answer in prose above the chart. The panel is glanced at, and
if the sparkline says it then the sentence is noise.
`.trim(),
  components: {
    Screen: defineComponent({
      props: z.object({ title: z.string() }),
      describe:
        "The root of a surface. Exactly one per surface, and every other component hangs off it. A short title in caps reads best at a glance.",
      a11y: { role: "region", name: { from: "prop", prop: "title" } },
      skeleton: { shape: "none" },
      examples: ['c s Screen title="RELATIONSHIPS"'],
    }),

    Stack: defineComponent({
      props: z.object({
        direction: z.enum(["vertical", "horizontal", "grid"]).optional(),
        gap: z.number().optional(),
        cols: z.number().min(1).max(4).optional(),
      }),
      describe:
        "Groups components. Vertical by default; use grid with cols for several small numbers, because four metrics in a column waste the height of a panel that is already capped. Gap is in units of 4 points.",
      a11y: { role: "group", name: { from: "none" } },
      skeleton: { shape: "none" },
      examples: ["c row Stack direction=grid cols=2 gap=3"],
    }),

    Heading: defineComponent({
      props: z.object({ text: z.string(), level: z.number().optional() }),
      describe:
        "A label over a section. Use it when one panel holds two unrelated groups; a panel with one group already has its Screen title.",
      a11y: { role: "heading", name: { from: "prop", prop: "text" } },
      skeleton: { shape: "text", lines: 1 },
      examples: ['c h Heading text="Needs a reply" level=2'],
    }),

    Text: defineComponent({
      props: z.object({
        value: z.string(),
        tone: z.enum(["muted"]).optional(),
      }),
      describe:
        "A sentence. Reach for it last: a heads-up display is glanced at, and prose is the thing a glance cannot do. Never use it to describe a chart that is already on the panel.",
      a11y: { role: "paragraph", name: { from: "children" } },
      skeleton: { shape: "text", lines: 2 },
      examples: ['c t Text value="Nothing is overdue." tone=muted'],
    }),

    List: defineComponent({
      props: z.object({
        items: z.array(z.string()),
        ordered: z.boolean().optional(),
      }),
      describe:
        "Plain bullets. Prefer Events when the items happened at times, and Bars when they have magnitudes worth comparing.",
      a11y: { role: "list", name: { from: "none" } },
      skeleton: { shape: "text", lines: 3 },
      examples: ['c l List items=["Bring the charger","Print the form"]'],
    }),

    Metric: defineComponent({
      props: z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
        unit: z.string().optional(),
        thresholds,
      }),
      describe:
        "One number that matters. Give it thresholds and it colours itself when the value crosses one, which is the difference between a number read at a glance and a number that has to be read.",
      a11y: { role: "group", name: { from: "prop", prop: "label" }, live: "polite" },
      skeleton: { shape: "block" },
      children: [],
      examples: [
        'c m Metric label="Unread" value=12',
        'c o Metric label="Overdue" value=4 thresholds=[{"at":1,"tone":"bad"}]',
      ],
    }),

    Table: defineComponent({
      props: z.object({
        caption: z.string().optional(),
        columns: z.array(z.object({ field: z.string(), label: z.string() })),
        rows: z.array(z.record(z.string(), z.unknown())),
      }),
      describe:
        "Rows with several fields each. Use it when the person needs to compare across columns; if there is one number per row, Bars says it faster.",
      a11y: { role: "table", name: { from: "prop", prop: "caption" } },
      skeleton: { shape: "block" },
      examples: [
        'c tb Table columns=[{"field":"name","label":"Name"},{"field":"due","label":"Due"}] rows=[{"name":"Origin Story","due":"Sep 9"}]',
      ],
    }),

    Status: defineComponent({
      props: z.object({
        message: z.string(),
        level: z.enum(["success", "warning", "error"]).optional(),
      }),
      describe:
        "One line about how something went. For an outcome, not for standing state: a panel that permanently says everything is fine is a panel nobody reads.",
      a11y: { role: "status", name: { from: "prop", prop: "message" }, live: "polite" },
      skeleton: { shape: "text", lines: 1 },
      examples: ['c st Status message="Deploy finished" level=success'],
    }),

    Sparkline: defineComponent({
      props: z.object({
        label: z.string(),
        points: z.array(z.number()),
        value: z.union([z.string(), z.number()]).optional(),
        tone,
      }),
      describe:
        "A trend. Six to thirty points: fewer is noise and more is a smear. Always pass value, because nobody reads an exact number off a 34-point chart, so the drawing carries the shape and the text carries the number.",
      a11y: { role: "img", name: { from: "prop", prop: "label" } },
      skeleton: { shape: "block" },
      children: [],
      examples: [
        'c sp Sparkline label="Messages this week" points=[31,28,44,39,58,52,71] value="71"',
      ],
    }),

    Bars: defineComponent({
      props: z.object({
        caption: z.string().optional(),
        rows: z.array(
          z.object({
            label: z.string(),
            value: z.number(),
            display: z.string().optional(),
          }),
        ),
        tone,
      }),
      describe:
        "Ranked rows, scaled against the largest rather than against zero, so four values within ten percent of each other still read as different. Horizontal because the labels are words. `display` is what gets printed; `value` only sets the length.",
      a11y: { role: "img", name: { from: "prop", prop: "caption" } },
      skeleton: { shape: "block" },
      children: [],
      examples: [
        'c b Bars caption="Time since last reply" rows=[{"label":"Sagar","value":2,"display":"2h"},{"label":"Ava","value":31,"display":"1d"}]',
      ],
    }),

    Ring: defineComponent({
      props: z.object({
        label: z.string().optional(),
        value: z.number().min(0).max(1),
        caption: z.string().optional(),
        tone,
        thresholds,
      }),
      describe:
        "A proportion, and only ever a proportion: value runs 0 to 1 and the thing must have a real ceiling. A ring around an unbounded number is decoration, and decoration costs the same attention as information while carrying none.",
      a11y: { role: "img", name: { from: "prop", prop: "label" } },
      children: [],
      skeleton: { shape: "block" },
      examples: ['c r Ring label="Attendance" value=0.82 caption="82%"'],
    }),

    Events: defineComponent({
      props: z.object({
        caption: z.string().optional(),
        items: z.array(
          z.union([
            z.string(),
            z.object({
              time: z.string().optional(),
              text: z.string(),
              accent: z.boolean().optional(),
            }),
          ]),
        ),
        tone,
      }),
      describe:
        "Things that happened or are about to, most recent or soonest first. Set accent on the one that matters; setting it on all of them sets it on none.",
      a11y: { role: "list", name: { from: "prop", prop: "caption" } },
      children: [],
      skeleton: { shape: "text", lines: 3 },
      examples: [
        'c e Events caption="Due" items=[{"time":"Sep 9","text":"Origin Story","accent":true}]',
      ],
    }),

    Diagram: defineComponent({
      props: z.object({
        aspect: z.number().optional(),
        parts: z.array(z.record(z.string(), z.unknown())),
        tone,
      }),
      describe:
        "Free-form drawing for a structure, a flow, or a relationship: the case no component anticipates. Every part is a shape in a unit square, so x and y run 0 to 1 and you never think about pixels. Do not use it to reimplement Bars.",
      a11y: { role: "img", name: { from: "prop", prop: "aspect" } },
      children: [],
      skeleton: { shape: "block" },
      examples: [
        'c d Diagram aspect=2.4 parts=[{"t":"node","x":0.2,"y":0.5,"label":"Model"},{"t":"arrow","x":0.32,"y":0.5,"x2":0.68,"y2":0.5},{"t":"node","x":0.8,"y":0.5,"label":"Glass"}]',
      ],
    }),

    File: defineComponent({
      props: z.object({
        path: z.string(),
        page: z.number().optional(),
        editable: z.boolean().optional(),
      }),
      describe:
        "Shows an actual file: a PDF through the system's PDF engine, an image as an image, anything that decodes as text as text. Use it when the person names a document, instead of describing the document back to them. `editable` on a text file gives a real editor whose save overwrites that exact path.",
      a11y: { role: "region", name: { from: "prop", prop: "path" } },
      children: [],
      skeleton: { shape: "block" },
      examples: ['c f File path="~/Downloads/resume.pdf"'],
    }),

    Button: defineComponent({
      props: z.object({
        label: z.string(),
        action: z.string(),
        variant: z.enum(["primary"]).optional(),
        collection: z.string().optional(),
      }),
      describe:
        "A press that sends an action back up the socket. Only add one when there is something for it to do; a button nobody is listening for is a promise the panel cannot keep.",
      a11y: {
        role: "button",
        name: { from: "prop", prop: "label" },
        keyboard: true,
      },
      children: [],
      skeleton: { shape: "text", lines: 1 },
      examples: ['c go Button label="Send it" action=send variant=primary'],
    }),

    Field: defineComponent({
      props: z.object({
        label: z.string(),
        bind: z.string(),
        placeholder: z.string().optional(),
      }),
      describe:
        "A text input bound to a pointer in the panel's own data. It writes locally the moment it is typed in, so it responds at typing speed whether or not anything is still listening.",
      a11y: {
        role: "textbox",
        name: { from: "prop", prop: "label" },
        keyboard: true,
      },
      children: [],
      skeleton: { shape: "text", lines: 1 },
      examples: ['c n Field label="Note" bind=/draft/note'],
    }),

    Select: defineComponent({
      props: z.object({
        label: z.string(),
        bind: z.string(),
        options: z.array(z.string()),
      }),
      describe:
        "One of a fixed set. Use it wherever the answer is a known list, because a text field that must match one of five strings is a trap.",
      a11y: {
        role: "combobox",
        name: { from: "prop", prop: "label" },
        keyboard: true,
      },
      children: [],
      skeleton: { shape: "text", lines: 1 },
      examples: ['c s Select label="Status" bind=/draft/status options=["Todo","Done"]'],
    }),

    Checkbox: defineComponent({
      props: z.object({ label: z.string(), bind: z.string() }),
      describe:
        "A yes or no, bound to a pointer. Use it for a state the person toggles, not for a list of things to tick off: several checkboxes in a row is a form, and a heads-up display is a bad place to fill in a form.",
      a11y: {
        role: "checkbox",
        name: { from: "prop", prop: "label" },
        keyboard: true,
      },
      children: [],
      skeleton: { shape: "text", lines: 1 },
      examples: ['c c Checkbox label="Urgent" bind=/draft/urgent'],
    }),
  },
});

/**
 * Also exported as `catalog`, which is the name `bob audit` and `bob prompt`
 * look for. Keeping both means the tools work on this file with no arguments
 * and callers can still import it by a name that says which catalog it is.
 */
export const catalog = hudCatalog;
export default hudCatalog;
