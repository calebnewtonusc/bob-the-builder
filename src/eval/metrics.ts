/**
 * Metrics over repeated runs of the same prompt.
 *
 * The centrepiece here is **stability**, and as far as I can find nobody
 * publishes it for generative UI.
 *
 * The strongest objection to the whole idea is that a regenerated interface
 * destroys muscle memory: people learn where things are, and an interface that
 * rearranges itself every time makes them relearn the same task forever. That
 * objection is correct in general and wrong in specific cases, and until now
 * there has been no way to tell which case you are in, because nobody measures
 * it. "It varies a bit" is not a number you can put in a pull request.
 *
 * So: run the same prompt N times and measure how much the resulting interface
 * actually moves. A catalog that scores 0.98 is safe to ship into a product with
 * repeat users. One that scores 0.4 is a demo, and the fix is almost always
 * ambiguous `describe` text rather than the model.
 *
 * Everything below is deterministic and computed from the specs themselves, with
 * no LLM judge, because the best published judge for generated interfaces agrees
 * with human annotators about 69% of the time and that is too weak to gate a
 * build on.
 */

import type { ComponentId, Spec } from "../core/spec.js";

/* -------------------------------------------------------------------------- */
/* Shape extraction                                                           */
/* -------------------------------------------------------------------------- */

/** Component types in render order, as a multiset. */
export function componentCounts(spec: Spec): Map<string, number> {
  const counts = new Map<string, number>();
  walk(spec, (node) => {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  });
  return counts;
}

/**
 * A canonical string for the tree's shape, ignoring ids and content.
 *
 * `Stack(Heading,Text,Stack(Metric,Metric),Table)` is the same layout whether
 * the numbers inside it changed or not, which is the distinction that matters:
 * users relearn a layout, not a value.
 */
export function shapeSignature(spec: Spec): string {
  if (!spec.root) return "";
  const seen = new Set<ComponentId>();

  const sig = (id: ComponentId): string => {
    if (seen.has(id)) return "…";
    seen.add(id);
    const node = spec.elements[id];
    if (!node || node.type === "__pending__") return "?";
    const kids = node.children.map(sig).filter(Boolean);
    return kids.length > 0 ? `${node.type}(${kids.join(",")})` : node.type;
  };

  return sig(spec.root);
}

export function treeDepth(spec: Spec): number {
  if (!spec.root) return 0;
  const seen = new Set<ComponentId>();
  const depth = (id: ComponentId): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const node = spec.elements[id];
    if (!node) return 0;
    const kids = node.children.map(depth);
    return 1 + (kids.length > 0 ? Math.max(...kids) : 0);
  };
  return depth(spec.root);
}

export function componentCount(spec: Spec): number {
  let n = 0;
  walk(spec, () => n++);
  return n;
}

function walk(spec: Spec, visit: (node: NonNullable<Spec["elements"][string]>) => void): void {
  if (!spec.root) return;
  const seen = new Set<ComponentId>();
  const go = (id: ComponentId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = spec.elements[id];
    if (!node || node.type === "__pending__") return;
    visit(node);
    for (const child of node.children) go(child);
  };
  go(spec.root);
}

/* -------------------------------------------------------------------------- */
/* Similarity                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Jaccard similarity over multisets: shared count over total count.
 *
 * Multiset rather than set because "one Metric" and "four Metrics" are
 * meaningfully different interfaces, and a plain set treats them as identical.
 */
export function multisetJaccard(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  if (keys.size === 0) return 1;
  let shared = 0;
  let total = 0;
  for (const key of keys) {
    const x = a.get(key) ?? 0;
    const y = b.get(key) ?? 0;
    shared += Math.min(x, y);
    total += Math.max(x, y);
  }
  return total === 0 ? 1 : shared / total;
}

function meanPairwise<T>(items: T[], score: (a: T, b: T) => number): number {
  if (items.length < 2) return 1;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      sum += score(items[i]!, items[j]!);
      pairs++;
    }
  }
  return pairs === 0 ? 1 : sum / pairs;
}

export interface StabilityReport {
  /** Weighted combination of the three below. 1.0 means every run agreed. */
  stability: number;
  /** Did the same components appear, in the same quantities? */
  components: number;
  /** Did the tree have the same shape? Fraction of run pairs that matched exactly. */
  shape: number;
  /** Did the tree stay the same size? 1 minus normalised spread of depth. */
  depth: number;
  /** Distinct shapes seen, most common first. Names the actual disagreement. */
  variants: { signature: string; runs: number }[];
  runs: number;
}

/**
 * Weights: components matter most, because a run that swapped a Table for a
 * paragraph produced a different answer, not a different layout. Shape is next.
 * Depth is a tiebreaker that catches a tree quietly growing a wrapper.
 */
const W_COMPONENTS = 0.5;
const W_SHAPE = 0.35;
const W_DEPTH = 0.15;

export function measureStability(specs: Spec[]): StabilityReport {
  if (specs.length === 0) {
    return {
      stability: 0,
      components: 0,
      shape: 0,
      depth: 0,
      variants: [],
      runs: 0,
    };
  }

  const counts = specs.map(componentCounts);
  const signatures = specs.map(shapeSignature);
  const depths = specs.map(treeDepth);

  const components = meanPairwise(counts, multisetJaccard);
  const shape = meanPairwise(signatures, (a, b) => (a === b ? 1 : 0));

  const maxDepth = Math.max(...depths);
  const minDepth = Math.min(...depths);
  const depth = maxDepth === 0 ? 1 : 1 - (maxDepth - minDepth) / maxDepth;

  const byShape = new Map<string, number>();
  for (const sig of signatures) byShape.set(sig, (byShape.get(sig) ?? 0) + 1);
  const variants = [...byShape.entries()]
    .map(([signature, runs]) => ({ signature, runs }))
    .sort((a, b) => b.runs - a.runs);

  return {
    stability:
      components * W_COMPONENTS + shape * W_SHAPE + depth * W_DEPTH,
    components,
    shape,
    depth,
    variants,
    runs: specs.length,
  };
}
