/**
 * The renderer. Walks the resolved graph from the root and draws it.
 *
 * Three behaviours here are the point of the whole library:
 *
 *   Nothing paints before the root resolves, so a surface never flashes a
 *   half-built tree on its way to being correct.
 *
 *   A child id that has not arrived renders that component's declared skeleton
 *   in place, and the real component replaces it without moving anything.
 *
 *   Bound props resolve against the data model at render time, not at parse
 *   time, so a data patch updates a value without rebuilding the component.
 */

import { memo, useCallback, type ComponentType, type ReactNode } from "react";
import type { Catalog, ComponentDefs, PropsOf } from "../core/catalog.js";
import type { ComponentId, Json, Spec } from "../core/spec.js";
import { isBinding } from "../core/spec.js";
import { resolveProps } from "../core/stream.js";
import type { SurfaceStore } from "../core/store.js";
import { BobSkeleton, BobSkeletonStyles } from "./skeleton.js";
import { useHasBobProvider } from "./live-region.js";

/** Props every rendered component receives on top of its own. */
export interface BobComponentExtras {
  /** Fire a catalog action back at the agent. */
  onAction: (name: string, payload?: Record<string, Json>) => void;
  /** Write a value back through a bound prop. No-op for unbound props. */
  onChange: (prop: string, value: Json) => void;
  children?: ReactNode;
}

/**
 * A component in the map, with its prop relationship deliberately erased.
 *
 * React props are contravariant, so a `ComponentType<{value: string}>` is not
 * assignable to a `ComponentType<Record<string, unknown>>` even though passing
 * the former a validated `{value}` is exactly what happens. The variance is
 * real and the safety it protects is not: props here were already checked
 * against the catalog's Zod schema and stripped to declared keys before the
 * renderer sees them, so the compile-time relationship is enforced at the map's
 * type (`ComponentMap<C>`) and released at the boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BobComponent = ComponentType<any>;

/**
 * The React component for every entry in a catalog, typed against the schema
 * that entry declared.
 *
 * Pass the catalog type and each component gets its real props:
 *
 *   const components: ComponentMap<typeof catalog> = {
 *     Metric: ({ label, value, delta }) => …,   // label: string, value: string | number
 *   };
 *
 * Missing a component, or misspelling a prop, is a compile error rather than a
 * silently dropped card at runtime. The untyped `Record<string, BobComponent>`
 * still works for a dynamically built map.
 */
export type ComponentMap<C extends ComponentDefs = never> = [C] extends [never]
  ? Record<string, BobComponent>
  : { [K in keyof C]: ComponentType<PropsOf<C[K]> & BobComponentExtras> };

const EMPTY_ANCESTORS: ReadonlySet<ComponentId> = new Set();

export interface BobSurfaceProps {
  spec: Spec;
  catalog: Catalog<ComponentDefs>;
  components: Record<string, BobComponent>;
  store?: SurfaceStore;
  /**
   * Where a bound input writes back to.
   *
   * `store` covers the streaming case, where a surface is being assembled by a
   * model and the store owns the data model. An app read from a file has no
   * stream and no store, so without this a two-way bound field renders its value
   * and silently discards every edit. Takes precedence over `store`.
   */
  onWrite?: (pointer: string, value: Json) => void;
  /** Whether the root has resolved. Before this, `fallback` renders. */
  ready?: boolean;
  onAction?: (name: string, payload?: Record<string, Json>) => void;
  fallback?: ReactNode;
  /** Rendered in place of a component the catalog does not know. */
  renderUnknown?: (type: string, id: ComponentId) => ReactNode;
  /** Max nesting depth before the renderer stops descending. Default 32. */
  maxDepth?: number;
}

export const BobSurface = memo(function BobSurface({
  spec,
  catalog,
  components,
  store,
  onWrite,
  ready = true,
  onAction,
  fallback = null,
  renderUnknown,
  maxDepth = 32,
}: BobSurfaceProps) {
  const hasProvider = useHasBobProvider();

  if (process.env["NODE_ENV"] !== "production" && !hasProvider) {
    console.warn(
      "[bob] <BobSurface> is rendering outside <BobProvider>. Live regions " +
        "will not exist at page load, so screen readers will announce nothing " +
        "as content streams in. Wrap your app root in <BobProvider>.",
    );
  }

  const handleAction = useCallback(
    (name: string, payload?: Record<string, Json>) => {
      if (!catalog.hasAction(name)) {
        if (process.env["NODE_ENV"] !== "production") {
          console.warn(
            `[bob] Action ${JSON.stringify(name)} is not in the catalog. ` +
              `Known actions: ${catalog.actionNames.join(", ") || "(none)"}`,
          );
        }
        return;
      }
      onAction?.(name, payload);
    },
    [catalog, onAction],
  );

  if (!ready || !spec.root) return <>{fallback}</>;

  /**
   * `ancestors` is the path from the root to this node, not a set of everything
   * already drawn.
   *
   * The difference matters twice. A global "seen" set makes the render function
   * impure, so React's development double-render finds it already full and draws
   * nothing at all. And it silently breaks a legitimate DAG: one component
   * referenced as a child of two parents would render under the first and vanish
   * under the second, which looks like a model bug and is not.
   *
   * Path-scoped, only a genuine cycle is cut, and rendering the same spec twice
   * gives the same output both times.
   */
  const renderNode = (
    id: ComponentId,
    depth: number,
    ancestors: ReadonlySet<ComponentId>,
  ): ReactNode => {
    if (depth > maxDepth) return null;

    // The model referenced an ancestor of this node. Cut the cycle rather than
    // recursing: a shallow tree is survivable, a hung renderer is not.
    if (ancestors.has(id)) return null;

    const node = spec.elements[id];

    // Not arrived yet, or a placeholder holding an edge. Draw the skeleton the
    // catalog declared for whatever is coming, when we can tell what that is.
    if (!node || node.type === "__pending__") {
      return <BobSkeleton key={id} spec={{ shape: "text", lines: 1 }} />;
    }

    const def = catalog.get(node.type);
    const Component = (components as Record<string, BobComponent | undefined>)[
      node.type
    ];

    if (!def || !Component) {
      return renderUnknown ? (
        <span key={id}>{renderUnknown(node.type, id)}</span>
      ) : null;
    }

    const resolved = resolveProps(node.props, spec.data);

    const handleChange = (prop: string, value: Json) => {
      const raw = node.props[prop];
      if (!isBinding(raw)) {
        if (process.env["NODE_ENV"] !== "production") {
          console.warn(
            `[bob] ${node.type}#${id} changed unbound prop ${JSON.stringify(prop)}. ` +
              `Bind it with @/pointer for the value to persist.`,
          );
        }
        return;
      }
      if (onWrite) onWrite(raw.$bind, value);
      else if (store) store.write(raw.$bind, value);
      else if (process.env["NODE_ENV"] !== "production") {
        console.warn(
          `[bob] ${node.type}#${id} has a bound prop but the surface has nowhere ` +
            `to write it. Pass onWrite, or a store when streaming.`,
        );
      }
    };

    const nextAncestors =
      node.children.length > 0 ? new Set(ancestors).add(id) : ancestors;

    const children =
      node.children.length > 0
        ? node.children.map((childId) =>
            renderNode(childId, depth + 1, nextAncestors),
          )
        : undefined;

    return (
      <Component
        key={id}
        {...resolved}
        onAction={handleAction}
        onChange={handleChange}
      >
        {children}
      </Component>
    );
  };

  return (
    <>
      <BobSkeletonStyles />
      {renderNode(spec.root, 0, EMPTY_ANCESTORS)}
    </>
  );
});
