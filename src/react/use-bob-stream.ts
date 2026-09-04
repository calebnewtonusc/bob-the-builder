/**
 * The hook. Point it at a stream of text and it hands back a spec that grows.
 *
 * Interruption is first-class rather than an error path. A user who stops an
 * agent mid-surface should keep what already rendered and be able to resume, not
 * watch the screen empty out. `abort()` leaves the last good spec in place, and
 * teams that shipped agentic products through 2025 and 2026 consistently report
 * that resume-not-restart is the difference between a tool people keep and one
 * they abandon.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Catalog } from "../core/catalog.js";
import type { Json, Spec, SurfaceEvent } from "../core/spec.js";
import { emptySpec } from "../core/spec.js";
import { BobStream, type WireFormat } from "../core/stream.js";
import { useAnnouncer } from "./live-region.js";

export type StreamStatus = "idle" | "streaming" | "ready" | "done" | "error" | "aborted";

export interface UseBobStreamOptions {
  catalog: Catalog;
  format?: WireFormat;
  mode?: "strict" | "lenient";
  /**
   * Announce surface milestones to screen readers. Default true. Announcements
   * are throttled by the provider, so this stays quiet during a fast stream.
   */
  announce?: boolean;
  onEvent?: (event: SurfaceEvent) => void;
  onAction?: (name: string, payload?: Record<string, Json>) => void;
}

export interface UseBobStreamResult {
  spec: Spec;
  status: StreamStatus;
  /** True once the root has resolved. Nothing should paint before this. */
  ready: boolean;
  /** Child ids referenced but not yet arrived. */
  pending: string[];
  warnings: string[];
  error: string | null;
  store: BobStream["store"] | null;
  /** Start a new surface from an async iterable of text chunks. */
  start: (source: AsyncIterable<string>) => Promise<void>;
  /** Feed a single chunk. For transports that push rather than iterate. */
  push: (chunk: string) => void;
  /** Close the current surface cleanly. */
  close: () => void;
  /** Stop now, keeping whatever has rendered. */
  abort: () => void;
  /** Clear everything and go back to idle. */
  reset: () => void;
}

export function useBobStream(opts: UseBobStreamOptions): UseBobStreamResult {
  const { catalog, format = "lines", mode = "lenient", announce = true } = opts;

  const [spec, setSpec] = useState<Spec>(emptySpec);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [pending, setPending] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<BobStream | null>(null);
  const abortRef = useRef(false);
  const { announce: say } = useAnnouncer();

  // Keep the latest callbacks reachable without making them stream identity.
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;

  const handleEvent = useCallback(
    (event: SurfaceEvent) => {
      onEventRef.current?.(event);
      switch (event.type) {
        case "ready":
          setSpec({ ...event.spec });
          setStatus("ready");
          if (announce) say("Results ready");
          return;
        case "patch":
          setSpec({ ...event.spec });
          return;
        case "pending":
          setPending(event.ids);
          return;
        case "done":
          setSpec({ ...event.spec });
          setStatus("done");
          return;
        case "warn":
          setWarnings((w) => [...w, event.message]);
          return;
        case "error":
          setError(event.message);
          setStatus("error");
          if (announce) say("Could not display these results", "assertive");
          return;
      }
    },
    [announce, say],
  );

  const create = useCallback(() => {
    const stream = new BobStream({ catalog, format, mode, onEvent: handleEvent });
    streamRef.current = stream;
    return stream;
  }, [catalog, format, mode, handleEvent]);

  const reset = useCallback(() => {
    streamRef.current = null;
    abortRef.current = false;
    setSpec(emptySpec());
    setStatus("idle");
    setPending([]);
    setWarnings([]);
    setError(null);
  }, []);

  const start = useCallback(
    async (source: AsyncIterable<string>) => {
      reset();
      abortRef.current = false;
      const stream = create();
      setStatus("streaming");
      try {
        for await (const chunk of source) {
          if (abortRef.current) break;
          stream.push(chunk);
        }
        if (abortRef.current) {
          setStatus("aborted");
          return;
        }
        stream.close();
      } catch (err) {
        // A transport failure after the root arrived is survivable: keep what
        // rendered and say so, rather than blanking a usable surface.
        const message = err instanceof Error ? err.message : String(err);
        if (stream.store.isReady) {
          setWarnings((w) => [...w, `Stream ended early: ${message}`]);
          setStatus("done");
        } else {
          setError(message);
          setStatus("error");
        }
      }
    },
    [create, reset],
  );

  const push = useCallback(
    (chunk: string) => {
      const stream = streamRef.current ?? create();
      if (status === "idle") setStatus("streaming");
      stream.push(chunk);
    },
    [create, status],
  );

  const close = useCallback(() => {
    streamRef.current?.close();
  }, []);

  const abort = useCallback(() => {
    abortRef.current = true;
    setStatus((s) => (s === "streaming" ? "aborted" : s));
  }, []);

  useEffect(() => () => {
    abortRef.current = true;
  }, []);

  const ready = status === "ready" || status === "done" || status === "aborted";

  return useMemo(
    () => ({
      spec,
      status,
      ready: ready && spec.root !== null,
      pending,
      warnings,
      error,
      store: streamRef.current?.store ?? null,
      start,
      push,
      close,
      abort,
      reset,
    }),
    [spec, status, ready, pending, warnings, error, start, push, close, abort, reset],
  );
}
