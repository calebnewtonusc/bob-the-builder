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

import { memo, useCallback, useMemo, type ComponentType, type ReactNode } from "react";
import type { Catalog } from "../core/catalog.js";
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

export type BobComponent = ComponentType<Record<string, unknown> & BobComponentExtras>;

export type ComponentMap = Record<string, BobComponent>;

export interface BobSurfaceProps {
  spec: Spec;
  catalog: Catalog;
  components: ComponentMap;
  store?: SurfaceStore;
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

  const seen = useMemo(() => new Set<ComponentId>(), [spec]);

  if (!ready || !spec.root) return <>{fallback}</>;

  const renderNode = (id: ComponentId, depth: number): ReactNode => {
    if (depth > maxDepth) return null;

    const node = spec.elements[id];

    // Not arrived yet, or a placeholder holding an edge. Draw the skeleton the
    // catalog declared for whatever is coming, when we can tell what that is.
    if (!node || node.type === "__pending__") {
      return <BobSkeleton key={id} spec={{ shape: "text", lines: 1 }} />;
    }

    // A cycle means the model referenced an ancestor. Cut it rather than
    // recursing: a shallow tree is a survivable failure, a hung renderer is not.
    if (seen.has(id)) return null;
    seen.add(id);

    const def = catalog.get(node.type);
    const Component = components[node.type];

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
      store?.write(raw.$bind, value);
    };

    const children =
      node.children.length > 0
        ? node.children.map((childId) => renderNode(childId, depth + 1))
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
      {renderNode(spec.root, 0)}
    </>
  );
});
