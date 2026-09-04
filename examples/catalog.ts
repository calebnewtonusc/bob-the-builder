/**
 * A starter catalog. Copy it, rename it, and replace these components with your
 * own design system.
 *
 * Everything here is deliberately small. A catalog of eight good components
 * generates better interfaces than a catalog of forty, because the model has to
 * choose, and every extra near-duplicate makes the choice worse. Add a component
 * when you have seen the model reach for something that does not exist, not in
 * anticipation of that happening.
 */

import { z } from "zod";
import { defineCatalog, defineComponent, defineAction } from "../src/core/index.js";

export const catalog = defineCatalog({
  name: "starter",

  guidance: `Prefer a Table when the user is comparing things, a Metric row when
they asked "how much" or "how many", and Text only when the answer really is
prose. If you find yourself writing a paragraph that describes numbers, you
wanted a Table.`,

  components: {
    Stack: defineComponent({
      props: z.object({
        gap: z.number().min(0).max(8).optional(),
        direction: z.enum(["vertical", "horizontal"]).optional(),
      }),
      describe:
        "Vertical or horizontal layout container. The default wrapper for a surface with more than one child.",
      a11y: { role: "group", name: { from: "none" } },
      skeleton: { shape: "none" },
      examples: ["c page Stack gap=4", "> page heading summary table"],
    }),

    Heading: defineComponent({
      props: z.object({
        text: z.string().min(1),
        level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      }),
      describe:
        "Section title. Use level 1 once per surface, then 2 and 3 in order. Never skip a level.",
      a11y: { role: "heading", name: { from: "prop", prop: "text" } },
      skeleton: { shape: "text", lines: 1 },
      children: [],
      examples: ['c heading Heading text="Q3 revenue by region" level=1'],
    }),

    Text: defineComponent({
      props: z.object({
        value: z.string(),
        tone: z.enum(["normal", "muted"]).optional(),
      }),
      describe:
        "A paragraph of prose. For anything with structure, reach for Table, Metric, or List instead.",
      a11y: { name: { from: "children" } },
      skeleton: { shape: "text", lines: 3 },
      children: [],
      examples: ['c summary Text value="Revenue grew 12% against a flat market."'],
    }),

    Metric: defineComponent({
      props: z.object({
        label: z.string().min(1),
        value: z.union([z.string(), z.number()]),
        delta: z.number().optional(),
        unit: z.string().optional(),
      }),
      describe:
        "One number that matters, with an optional change against the prior period. Put two to four side by side in a horizontal Stack.",
      a11y: {
        role: "group",
        name: { from: "prop", prop: "label" },
        live: "polite",
      },
      skeleton: { shape: "block" },
      children: [],
      examples: [
        'c rev Metric label="Revenue" value=4820000 unit=USD delta=12.4',
        "c rev Metric label=\"Open tickets\" value=@/tickets/open",
      ],
    }),

    Table: defineComponent({
      props: z.object({
        caption: z.string().min(1),
        columns: z.array(z.string()).min(1),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
      }),
      describe:
        "Rows and columns for comparison. The caption is read aloud before the data, so say what the table shows, not just what it is called.",
      a11y: { role: "table", name: { from: "prop", prop: "caption" } },
      skeleton: { shape: "block" },
      children: [],
      examples: [
        'c t Table caption="Revenue by region, Q3" columns=["Region","Revenue","Change"] rows=[["West",1840000,8.2],["East",1520000,-3.1]]',
      ],
    }),

    List: defineComponent({
      props: z.object({
        items: z.array(z.string()).min(1),
        ordered: z.boolean().optional(),
      }),
      describe:
        "Short related items with no columns. Use ordered when sequence matters.",
      a11y: { role: "list", name: { from: "none" } },
      skeleton: { shape: "text", lines: 3 },
      children: [],
      examples: ['c risks List items=["Supply delay in APAC","FX exposure on EUR"]'],
    }),

    Field: defineComponent({
      props: z.object({
        label: z.string().min(1),
        value: z.string().optional(),
        placeholder: z.string().optional(),
        kind: z.enum(["text", "email", "number", "date"]).optional(),
      }),
      describe:
        "A single labelled input. Bind value to the data model with @/pointer so what the user types survives the next update.",
      a11y: {
        role: "textbox",
        name: { from: "prop", prop: "label" },
        keyboard: true,
      },
      skeleton: { shape: "block" },
      children: [],
      examples: ['c email Field label="Work email" kind=email value=@/contact/email'],
    }),

    Button: defineComponent({
      props: z.object({
        label: z.string().min(1),
        action: z.string().min(1),
        variant: z.enum(["primary", "secondary", "danger"]).optional(),
      }),
      describe:
        "Fires an action back at the agent. The label says what happens, so write the verb: Send report, not Submit.",
      a11y: {
        role: "button",
        name: { from: "prop", prop: "label" },
        keyboard: true,
      },
      skeleton: { shape: "block" },
      children: [],
      examples: ['c go Button label="Email this report" action=send_report variant=primary'],
    }),

    Status: defineComponent({
      props: z.object({
        message: z.string().min(1),
        level: z.enum(["info", "success", "warning", "error"]),
      }),
      describe:
        "Reports the outcome of something. Announced to screen readers, so use it for results and validation rather than decoration.",
      a11y: {
        role: "status",
        name: { from: "prop", prop: "message" },
        live: "polite",
      },
      skeleton: { shape: "text", lines: 1 },
      children: [],
      examples: ['c ok Status message="Report sent to 4 recipients" level=success'],
    }),
  },

  actions: {
    send_report: defineAction({
      payload: z.object({ recipients: z.array(z.string()).optional() }),
      describe: "Email the current report. Ask for recipients if none are known.",
    }),
    refine: defineAction({
      payload: z.object({ query: z.string() }),
      describe: "Re-run the analysis with a narrower question.",
    }),
    export_csv: defineAction({
      describe: "Download the table currently on screen as CSV.",
    }),
  },
});

export default catalog;
