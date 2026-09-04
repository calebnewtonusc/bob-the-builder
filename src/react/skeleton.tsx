/**
 * Placeholders that do not move when the real content lands.
 *
 * The bug this prevents is small and pervasive: a grey rectangle is replaced by
 * text in a different face at a different measure, the line boxes resize, and
 * the eye reads first-token as a page reload rather than as the same content
 * continuing to arrive. Everything below the swap shifts, and the interface
 * feels slower than the identical stream with a matched placeholder.
 *
 * The fix is that a skeleton has to inherit typography from the component it is
 * standing in for, which is why the skeleton shape is declared on the catalog
 * entry rather than chosen at the call site. The component and its placeholder
 * cannot drift apart if they are defined together.
 */

import type { CSSProperties } from "react";
import type { SkeletonSpec } from "../core/catalog.js";

export interface SkeletonProps {
  spec?: SkeletonSpec;
  /**
   * Approximate character count of the content that will replace this, when
   * known. Sizing to the real length keeps the reflow to a few pixels instead of
   * a whole line.
   */
  chars?: number;
  style?: CSSProperties;
}

const shimmer: CSSProperties = {
  background:
    "linear-gradient(90deg, var(--weft-skeleton, currentColor) 0%, var(--weft-skeleton-hi, currentColor) 50%, var(--weft-skeleton, currentColor) 100%)",
  backgroundSize: "200% 100%",
  opacity: 0.12,
  borderRadius: 3,
  animation: "weft-shimmer 1.4s ease-in-out infinite",
};

/**
 * Keyframes and the reduced-motion opt-out ship as a single style tag rather
 * than a stylesheet import, so `weft/react` stays a drop-in with no build step
 * and no CSS ordering problem.
 */
export function WeftSkeletonStyles() {
  return (
    <style>{`
@keyframes weft-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  [data-weft-skeleton] { animation: none !important; }
}
`}</style>
  );
}

export function WeftSkeleton({ spec, chars, style }: SkeletonProps) {
  const shape = spec?.shape ?? "text";

  // A container has no ink of its own. Drawing a box for one invents a shape the
  // real component never had, which is the reflow this file exists to avoid.
  if (shape === "none") return null;

  if (shape === "block") {
    return (
      <div
        data-weft-skeleton="block"
        aria-hidden="true"
        style={{ ...shimmer, width: "100%", height: "100%", minHeight: "1.5em", ...style }}
      />
    );
  }

  const lines = spec?.lines ?? 1;
  return (
    <span
      data-weft-skeleton="text"
      aria-hidden="true"
      style={{ display: "inline-flex", flexDirection: "column", gap: "0.35em", width: "100%", ...style }}
    >
      {Array.from({ length: lines }, (_, i) => {
        // Last line short, the way a real paragraph ends. A stack of full-width
        // bars reads as a table, not as prose.
        const last = i === lines - 1 && lines > 1;
        const width = last ? "62%" : chars ? `min(100%, ${chars}ch)` : "100%";
        return (
          <span
            key={i}
            data-weft-skeleton="line"
            style={{ ...shimmer, display: "block", width, height: "1em" }}
          />
        );
      })}
    </span>
  );
}
