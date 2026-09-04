/**
 * The built-in catalog every app is assembled from.
 *
 * Small on purpose. These twelve components cover what a person actually builds
 * for themselves: a list of things, a form to add one, some counts, and a couple
 * of buttons. A model choosing among twelve well-described components makes
 * better interfaces than one choosing among forty, and every near-duplicate
 * makes the choice worse.
 *
 * Nothing here is styled. A component is a promise about meaning and
 * accessibility; how it looks belongs to whoever renders it.
 */

import { z } from "zod";
import { defineAction, defineCatalog, defineComponent } from "../core/catalog.js";

export const appCatalog = defineCatalog({
  name: "personal",

  guidance: `Build the smallest interface that does the job. Most personal apps are
one heading, a few counts, a table of records, and a form to add one.

Bind every table to its collection with @/pointer, and bind every form field to
the draft at @/draft/<collection>/<field>. Never put a record's values directly
in props: data lives in the data model so it survives an edit to the layout.

Counts, totals and averages are computed, not typed. Use a Metric with $count,
$sum or $avg rather than writing a number that will be wrong tomorrow. Those are
the only three; anything else you invent is dropped.`,

  components: {
    Screen: defineComponent({
      props: z.object({ title: z.string().min(1) }),
      describe:
        "The outermost container of an app. Exactly one per app, always the root. Its title names the app in the window.",
      a11y: { role: "main", name: { from: "prop", prop: "title" } },
      skeleton: { shape: "none" },
      examples: ['c app Screen title="Job applications"'],
    }),

    Stack: defineComponent({
      props: z.object({
        gap: z.number().min(0).max(8).optional(),
        direction: z.enum(["vertical", "horizontal"]).optional(),
      }),
      describe:
        "Groups children vertically or horizontally. Use a horizontal Stack to put two to four Metrics in a row.",
      a11y: { role: "group", name: { from: "none" } },
      skeleton: { shape: "none" },
      examples: ["c row Stack direction=horizontal gap=3"],
    }),

    Heading: defineComponent({
      props: z.object({
        text: z.string().min(1),
        level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      }),
      describe:
        "A section title. Level 1 once per screen, then 2 and 3 in order, never skipping a level.",
      a11y: { role: "heading", name: { from: "prop", prop: "text" } },
      skeleton: { shape: "text", lines: 1 },
      children: [],
      examples: ['c h Heading text="This week" level=2'],
    }),

    Text: defineComponent({
      props: z.object({
        value: z.string(),
        tone: z.enum(["normal", "muted"]).optional(),
      }),
      describe:
        "A line or paragraph of prose. For anything with structure use Table, Metric, or List instead.",
      a11y: { name: { from: "children" } },
      skeleton: { shape: "text", lines: 2 },
      children: [],
      examples: ['c note Text value="Log an application as soon as you send it." tone=muted'],
    }),

    Metric: defineComponent({
      props: z.object({
        label: z.string().min(1),
        value: z.union([z.string(), z.number()]),
        unit: z.string().optional(),
      }),
      describe:
        "One number that matters. Use a computed value so it stays true. Exactly three forms exist: {\"$count\":\"/applications\"}, optionally with \"where\":{\"field\":\"status\",\"equals\":\"Interview\"}; {\"$sum\":\"/expenses\",\"field\":\"amount\"}; and {\"$avg\":\"/books\",\"field\":\"rating\"}. Nothing else computes. Two to four in a horizontal Stack.",
      a11y: { role: "group", name: { from: "prop", prop: "label" }, live: "polite" },
      skeleton: { shape: "block" },
      children: [],
      examples: [
        'c total Metric label="Applications" value={"$count":"/applications"}',
        'c open Metric label="Interviewing" value={"$count":"/applications","where":{"field":"status","equals":"Interview"}}',
      ],
    }),

    Table: defineComponent({
      props: z.object({
        caption: z.string().min(1),
        rows: z.array(z.record(z.unknown())).optional(),
        columns: z.array(z.object({ field: z.string(), label: z.string() })).min(1),
        collection: z.string().min(1),
        removable: z.boolean().optional(),
      }),
      describe:
        "The records in a collection, one row each. Bind rows to the collection with @/pointer and name the columns by field. Set removable when the person should be able to delete a row.",
      a11y: { role: "table", name: { from: "prop", prop: "caption" } },
      skeleton: { shape: "block" },
      children: [],
      examples: [
        'c t Table caption="All applications" collection=applications rows=@/applications columns=[{"field":"company","label":"Company"},{"field":"status","label":"Status"}] removable=true',
      ],
    }),

    List: defineComponent({
      props: z.object({
        items: z.array(z.string()).min(1),
        ordered: z.boolean().optional(),
      }),
      describe:
        "A few fixed related items, written by you rather than stored as records. For records use Table.",
      a11y: { role: "list", name: { from: "none" } },
      skeleton: { shape: "text", lines: 3 },
      children: [],
      examples: ['c steps List items=["Send CV","Follow up in a week"] ordered=true'],
    }),

    Field: defineComponent({
      props: z.object({
        label: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        kind: z.enum(["text", "number", "date", "url", "longtext"]).optional(),
        placeholder: z.string().optional(),
      }),
      describe:
        "One labelled input. Always bind value to the draft: @/draft/<collection>/<field>. The label is read aloud, so write it for someone who cannot see the screen.",
      a11y: { role: "textbox", name: { from: "prop", prop: "label" }, keyboard: true },
      skeleton: { shape: "block" },
      children: [],
      examples: ['c company Field label="Company" value=@/draft/applications/company'],
    }),

    Select: defineComponent({
      props: z.object({
        label: z.string().min(1),
        value: z.string().optional(),
        options: z.array(z.string()).min(1),
      }),
      describe:
        "A choice from a fixed set. Use when the schema field is a select, and pass the same options the schema declares.",
      a11y: { role: "combobox", name: { from: "prop", prop: "label" }, keyboard: true },
      skeleton: { shape: "block" },
      children: [],
      examples: [
        'c status Select label="Status" value=@/draft/applications/status options=["Applied","Interview","Offer","Rejected"]',
      ],
    }),

    Checkbox: defineComponent({
      props: z.object({
        label: z.string().min(1),
        value: z.boolean().optional(),
      }),
      describe: "A single yes or no. Bind value to the draft field.",
      a11y: { role: "checkbox", name: { from: "prop", prop: "label" }, keyboard: true },
      skeleton: { shape: "block" },
      children: [],
      examples: ['c remote Checkbox label="Remote" value=@/draft/applications/remote'],
    }),

    Button: defineComponent({
      props: z.object({
        label: z.string().min(1),
        action: z.string().min(1),
        collection: z.string().optional(),
        variant: z.enum(["primary", "secondary", "danger"]).optional(),
      }),
      describe:
        "Runs an action. The label says what happens, so write the verb: Add application, not Submit. Pass collection for add and clear.",
      a11y: { role: "button", name: { from: "prop", prop: "label" }, keyboard: true },
      skeleton: { shape: "block" },
      children: [],
      examples: [
        'c add Button label="Add application" action=add collection=applications variant=primary',
      ],
    }),

    Status: defineComponent({
      props: z.object({
        message: z.string().min(1),
        level: z.enum(["info", "success", "warning", "error"]),
      }),
      describe:
        "Reports the outcome of something the person did. Announced to screen readers, so use it for results and validation rather than decoration.",
      a11y: { role: "status", name: { from: "prop", prop: "message" }, live: "polite" },
      skeleton: { shape: "text", lines: 1 },
      children: [],
      examples: ['c ok Status message="Application saved" level=success'],
    }),
  },

  actions: {
    add: defineAction({
      describe: "Append the current draft to a collection and clear the draft.",
    }),
    remove: defineAction({
      describe: "Delete one record from a collection.",
    }),
    update: defineAction({
      describe: "Change one field of one record in place.",
    }),
    clearDraft: defineAction({
      describe: "Abandon the record currently being filled in.",
    }),
  },
});

export default appCatalog;
