/**
 * The catalog is the toolbox: the complete set of parts Bob is allowed to build
 * with. Nothing outside it can reach the screen.
 *
 * A catalog entry carries more than a props schema. It also declares the things
 * that are impossible to recover later, once a model is emitting specs at
 * runtime:
 *
 *   - `a11y`      where the accessible name comes from, so `bob audit` can
 *                 check a component once instead of auditing generated output
 *                 forever. This is the one real leverage point: a catalog is
 *                 finite, generated HTML is not.
 *   - `skeleton`  what to draw while the component's own props are still
 *                 arriving. Declared alongside the component so the placeholder
 *                 and the real thing share a typeface and a measure, which is
 *                 what stops first-token from reading as a page reload.
 *   - `describe`  one line for the system prompt. The model picks components by
 *                 this text, so it is functional, not documentation.
 */

import type { z } from "zod";
import type { ComponentId } from "./spec.js";

/** How a component exposes its accessible name. */
export type A11yName =
  /** The named prop is the accessible name. */
  | { from: "prop"; prop: string }
  /** Text children provide the name. */
  | { from: "children" }
  /** Decorative: correctly has no accessible name. */
  | { from: "none" };

export interface A11ySpec {
  /**
   * ARIA role this component renders with. `audit` uses it to decide which
   * rules apply, so declare the role you actually render, not the one you meant.
   */
  role?: string;
  /** Where the accessible name comes from. Required for interactive roles. */
  name: A11yName;
  /**
   * True if a keyboard user can reach and operate it. Interactive roles that
   * declare `false` fail the audit.
   */
  keyboard?: boolean;
  /**
   * Announce changes to this component's content through the live region.
   * Use for status, results, and validation, not for decorative motion.
   */
  live?: "polite" | "assertive";
}

export interface SkeletonSpec {
  /**
   * Shape of the placeholder. `text` reserves line boxes at the component's own
   * type scale; `block` reserves a box; `none` renders nothing (correct for
   * containers, which have no ink of their own).
   */
  shape: "text" | "block" | "none";
  /** Lines to reserve when `shape` is `text`. */
  lines?: number;
}

export interface ComponentDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Props schema. Doubles as the contract sent to the model and the runtime guard. */
  props: S;
  /** One line, written for the model. What is this for, and when should it be picked. */
  describe: string;
  a11y: A11ySpec;
  skeleton?: SkeletonSpec;
  /** Component names allowed as children. Omit to allow any. Empty array means leaf. */
  children?: string[];
  /** Short examples that go in the prompt. Two good ones beat ten mediocre. */
  examples?: string[];
}

export interface ActionDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  payload?: S;
  describe: string;
}

export interface CatalogInit {
  name: string;
  components: Record<string, ComponentDef>;
  actions?: Record<string, ActionDef>;
  /** Extra guidance appended to the generated system prompt. */
  guidance?: string;
}

export interface Catalog extends CatalogInit {
  actions: Record<string, ActionDef>;
  componentNames: string[];
  actionNames: string[];
  has(type: string): boolean;
  hasAction(name: string): boolean;
  get(type: string): ComponentDef | undefined;
  /** True if `child` is allowed inside `parent` per the catalog's own rules. */
  allowsChild(parent: string, child: string): boolean;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(id: string): id is ComponentId {
  return ID_RE.test(id);
}

export function defineComponent<S extends z.ZodTypeAny>(
  def: ComponentDef<S>,
): ComponentDef<S> {
  return def;
}

export function defineAction<S extends z.ZodTypeAny>(
  def: ActionDef<S>,
): ActionDef<S> {
  return def;
}

export function defineCatalog(init: CatalogInit): Catalog {
  const actions = init.actions ?? {};
  const componentNames = Object.keys(init.components).sort();
  const actionNames = Object.keys(actions).sort();

  for (const name of componentNames) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
      throw new Error(
        `Component name ${JSON.stringify(name)} must be PascalCase. ` +
          `The model uses casing to tell components from props.`,
      );
    }
    const def = init.components[name]!;
    for (const child of def.children ?? []) {
      if (!(child in init.components)) {
        throw new Error(
          `Component ${name} allows child ${JSON.stringify(child)}, ` +
            `which is not in the catalog.`,
        );
      }
    }
  }

  return {
    ...init,
    actions,
    componentNames,
    actionNames,
    has: (type) => type in init.components,
    hasAction: (name) => name in actions,
    get: (type) => init.components[type],
    allowsChild(parent, child) {
      const def = init.components[parent];
      if (!def) return false;
      if (def.children === undefined) return true;
      return def.children.includes(child);
    },
  };
}
