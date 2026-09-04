/**
 * Catalog to system prompt.
 *
 * The catalog is already the single source of truth for what the model may
 * emit, so the prompt is generated from it rather than written by hand. A
 * hand-written prompt drifts from the code the first time someone adds a
 * component, and the failure is silent: the model keeps emitting a component
 * that no longer exists and the store keeps dropping it.
 *
 * Prompt content is deliberately mostly *examples*. Type signatures tell a model
 * what is legal; examples tell it what is idiomatic, and the gap between those
 * two is where most bad generated UI lives.
 */

import type { z } from "zod";
import type { Catalog, ComponentDef } from "./catalog.js";
import type { WireFormat } from "./stream.js";

/**
 * Best-effort Zod introspection.
 *
 * Zod's internals differ between v3 and v4 and are not a public API, so this
 * reads what it can and degrades to `unknown` rather than throwing. That is an
 * acceptable trade because a wrong-but-plausible type hint costs the model very
 * little next to a good example, and the store validates for real at runtime.
 */
function describeSchema(schema: z.ZodTypeAny, depth = 0): string {
  if (depth > 4) return "unknown";
  const def = (schema as unknown as { _def?: Record<string, unknown> })?._def;
  if (!def) return "unknown";

  const typeName =
    (def["typeName"] as string | undefined) ??
    (def["type"] as string | undefined) ??
    "";

  const inner = def["innerType"] as z.ZodTypeAny | undefined;

  switch (typeName) {
    case "ZodString":
    case "string":
      return "string";
    case "ZodNumber":
    case "number":
      return "number";
    case "ZodBoolean":
    case "boolean":
      return "boolean";
    case "ZodNull":
    case "null":
      return "null";
    case "ZodAny":
    case "ZodUnknown":
      return "unknown";
    case "ZodLiteral":
    case "literal":
      return JSON.stringify(def["value"]);
    case "ZodEnum":
    case "enum": {
      const values =
        (def["values"] as string[] | undefined) ??
        (Object.keys((def["entries"] as object) ?? {}) as string[]);
      return values.length > 0 ? values.join(" | ") : "string";
    }
    case "ZodOptional":
    case "optional":
      return inner ? `${describeSchema(inner, depth + 1)}?` : "unknown?";
    case "ZodDefault":
    case "default":
      return inner ? describeSchema(inner, depth + 1) : "unknown";
    case "ZodNullable":
    case "nullable":
      return inner ? `${describeSchema(inner, depth + 1)} | null` : "unknown";
    case "ZodArray":
    case "array": {
      const el = (def["type"] ?? def["element"]) as z.ZodTypeAny | undefined;
      return el ? `${describeSchema(el, depth + 1)}[]` : "unknown[]";
    }
    case "ZodUnion":
    case "union": {
      const options = (def["options"] as z.ZodTypeAny[] | undefined) ?? [];
      return options.length > 0
        ? options.map((o) => describeSchema(o, depth + 1)).join(" | ")
        : "unknown";
    }
    case "ZodObject":
    case "object": {
      const shapeSrc = def["shape"];
      const shape =
        typeof shapeSrc === "function"
          ? (shapeSrc as () => Record<string, z.ZodTypeAny>)()
          : (shapeSrc as Record<string, z.ZodTypeAny> | undefined);
      if (!shape) return "object";
      const fields = Object.entries(shape)
        .map(([k, v]) => `${k}: ${describeSchema(v, depth + 1)}`)
        .join(", ");
      return `{ ${fields} }`;
    }
    default:
      return "unknown";
  }
}

function propLines(def: ComponentDef): string[] {
  const shapeSrc = (def.props as unknown as { _def?: Record<string, unknown> })
    ._def?.["shape"];
  const shape =
    typeof shapeSrc === "function"
      ? (shapeSrc as () => Record<string, z.ZodTypeAny>)()
      : (shapeSrc as Record<string, z.ZodTypeAny> | undefined);

  if (!shape) return [];
  return Object.entries(shape).map(
    ([key, schema]) => `${key}=${describeSchema(schema)}`,
  );
}

const FORMAT_RULES: Record<WireFormat, string> = {
  lines: `Emit Bob Lines. One instruction per line, nothing else. No prose, no
markdown, no code fences.

  c <id> <Type> [prop=value ...]   declare a component
  > <id> <child> [child ...]       give a component its children
  d <pointer> <json>               set a value in the data model
  r <id>                           declare the root component

Values: bare words (primary), "quoted strings" when they contain spaces,
numbers, true, false, null, inline JSON for objects and arrays, @/pointer to
bind a prop to the data model, and !actionName to reference an action.

Order matters for how fast the user sees something. Declare the root component,
then \`r\` naming it, then everything else:

  c page Stack gap=4
  r page
  > page title body
  c title Heading text="…" level=1
  c body Text value="…"

Nothing can render until \`r\` arrives, so emitting it second means the surface
appears immediately and fills in as the rest streams. Emitting it last means the
user stares at nothing until the whole response is finished.

After that, components may arrive in any order, and a parent may name children
that do not exist yet.`,

  jsonl: `Emit one JSON operation per line. No prose, no markdown, no code fences.

  {"op":"component","node":{"id":"…","type":"…","props":{},"children":[]}}
  {"op":"children","id":"…","children":["…"]}
  {"op":"data","path":"/pointer","value":…}
  {"op":"root","id":"…"}

Emit the root component first, then the root op naming it, then everything else.
Nothing renders until the root op arrives, so sending it second makes the surface
appear immediately instead of after the whole response.

Bind a prop to the data model with {"$bind":"/pointer"} as its value.`,

  json: `Emit a single JSON object and nothing else. No prose, no markdown, no
code fences.

  {
    "root": "<id>",
    "elements": { "<id>": { "type": "…", "props": {}, "children": [] } },
    "data": {}
  }

Bind a prop to the data model with {"$bind":"/pointer"} as its value.`,
};

export interface PromptOptions {
  format?: WireFormat;
  /** Include per-component examples. Default true, and worth the tokens. */
  examples?: boolean;
  /** Extra task-specific instructions, appended last. */
  task?: string;
}

export function buildSystemPrompt(
  catalog: Catalog,
  opts: PromptOptions = {},
): string {
  const format = opts.format ?? "lines";
  const includeExamples = opts.examples ?? true;
  const out: string[] = [];

  out.push(
    `You render user interfaces by emitting a UI specification. You are not
writing code and you are not writing prose: you are choosing components from a
fixed catalog and giving them content.`,
  );

  out.push(FORMAT_RULES[format]);

  out.push(`## Catalog: ${catalog.name}

Use only the components below. A component that is not listed does not exist,
and emitting one drops that part of the interface.`);

  for (const name of catalog.componentNames) {
    const def = catalog.components[name]!;
    const props = propLines(def);
    const parts: string[] = [`### ${name}`, def.describe];

    if (props.length > 0) parts.push(`Props: ${props.join(", ")}`);
    if (def.children !== undefined) {
      parts.push(
        def.children.length === 0
          ? `Children: none, this is a leaf.`
          : `Children: ${def.children.join(", ")}`,
      );
    }
    if (def.a11y.name.from === "prop") {
      parts.push(
        `Accessibility: \`${def.a11y.name.prop}\` is the accessible name. It is read aloud, so write it for someone who cannot see the screen.`,
      );
    }
    if (includeExamples && def.examples?.length) {
      parts.push(def.examples.map((e) => `  ${e}`).join("\n"));
    }
    out.push(parts.join("\n"));
  }

  if (catalog.actionNames.length > 0) {
    const actions = catalog.actionNames
      .map((n) => `- ${n}: ${catalog.actions[n]!.describe}`)
      .join("\n");
    out.push(`## Actions\n\nInteractive components reference these by name.\n\n${actions}`);
  }

  out.push(`## Rules

1. Pick the component that matches the shape of the answer. A comparison is a
   table, a trend is a chart, a choice is a set of options. Reach for plain text
   only when the answer really is prose.
2. Every id is unique within a surface and made of letters, digits, - and _.
3. Write real content into props. Never emit placeholder text.
   Banned outright: "Lorem ipsum", "Item 1", "TODO", "Your text here".
4. Put values a user might edit, or that you will update later, in the data model
   and bind to them. Put fixed labels directly in props.
5. Do not invent props. A prop that is not listed for a component is dropped.
6. Prefer fewer, larger components over deeply nested small ones. Depth costs
   tokens and gives the user nothing.`);

  if (catalog.guidance) out.push(`## Catalog guidance\n\n${catalog.guidance}`);
  if (opts.task) out.push(`## Task\n\n${opts.task}`);

  return out.join("\n\n");
}
