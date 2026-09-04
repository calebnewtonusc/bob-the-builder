/**
 * Model adapters.
 *
 * The interface is one method on purpose. Anything that can produce text given a
 * system prompt and a user prompt is a valid model here, which keeps the eval
 * harness usable with an SDK, a raw fetch, a local model, or a recording.
 *
 * The recording case matters more than it looks. An eval suite that needs an API
 * key cannot run in CI on a fork, cannot run offline, and produces a different
 * answer every time it runs, which makes it useless as a regression gate. So
 * `replayAdapter` lets you capture real model output once, commit it, and have
 * the deterministic half of the suite, assertions, shape, cost, first paint,
 * run everywhere for free. Stability still needs live runs, because varying is
 * the thing it measures.
 */

export interface ModelAdapter {
  /** Shown in reports and stored in the baseline, so a model swap is visible. */
  name: string;
  /** Yield the response in chunks. Chunk boundaries do not have to be lines. */
  stream(system: string, user: string): AsyncIterable<string>;
}

export interface ReplayFixtures {
  /** Scenario name to one recorded response per run. */
  [scenario: string]: string[];
}

/**
 * Serve recorded responses instead of calling a model.
 *
 * Runs cycle through the recordings, so three recordings across five runs
 * replays 1,2,3,1,2. That keeps a suite meaningful when you only captured a few.
 */
export function replayAdapter(
  fixtures: ReplayFixtures,
  opts: { name?: string; chunkSize?: number } = {},
): ModelAdapter {
  const counters = new Map<string, number>();
  const chunkSize = opts.chunkSize ?? 24;

  return {
    name: opts.name ?? "replay",
    async *stream(_system, user) {
      const recordings = fixtures[user];
      if (!recordings || recordings.length === 0) {
        throw new Error(
          `No recorded response for scenario ${JSON.stringify(user)}. ` +
            `Recorded scenarios: ${Object.keys(fixtures).join(", ") || "(none)"}`,
        );
      }
      const n = counters.get(user) ?? 0;
      counters.set(user, n + 1);
      const text = recordings[n % recordings.length]!;

      // Chunked rather than yielded whole, so first-paint timing is measured
      // against a stream rather than against one atomic delivery.
      for (let i = 0; i < text.length; i += chunkSize) {
        yield text.slice(i, i + chunkSize);
      }
    },
  };
}

/**
 * Wrap any function that returns an async iterable of text.
 *
 * Most SDK streaming APIs are one `.map()` away from fitting this, which is the
 * point of keeping the interface at one method.
 */
export function defineAdapter(
  name: string,
  stream: (system: string, user: string) => AsyncIterable<string>,
): ModelAdapter {
  return { name, stream };
}
