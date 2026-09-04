/**
 * The live region, and why it is a provider rather than a component you drop in
 * next to the thing that needs it.
 *
 * Several screen readers ignore an `aria-live` region that was not present in
 * the DOM when the page loaded. They subscribe at load and never notice a region
 * injected later.
 *
 * Streaming generative UI injects everything dynamically. That is the whole
 * architecture. So the default behaviour of a streamed interface is that a
 * screen reader user is told nothing as content arrives, and the smoother the
 * streaming looks, the more completely it fails for anyone not watching it.
 *
 * The fix is to mount the regions once, empty, at the top of the app, and stream
 * text *into* them. That has to be structural or it will not survive contact
 * with a deadline, so `WeftProvider` is the only supported way to render a
 * surface, and it always renders the regions whether or not anything announces.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type Politeness = "polite" | "assertive";

export interface Announcer {
  announce: (message: string, politeness?: Politeness) => void;
}

const AnnouncerContext = createContext<Announcer | null>(null);

/**
 * Announce to assistive technology. Outside a `WeftProvider` this is a no-op in
 * production and a console warning in development, because a silent failure
 * here is invisible to everyone who is not using a screen reader.
 */
export function useAnnouncer(): Announcer {
  const ctx = useContext(AnnouncerContext);
  return useMemo(
    () =>
      ctx ?? {
        announce: () => {
          if (process.env["NODE_ENV"] !== "production") {
            console.warn(
              "[weft] useAnnouncer() outside <WeftProvider>. Screen reader " +
                "announcements are being dropped. Wrap your app root in " +
                "<WeftProvider> so the live regions exist at page load.",
            );
          }
        },
      },
    [ctx],
  );
}

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

export interface WeftProviderProps {
  children: ReactNode;
  /**
   * Minimum gap between announcements, in ms. Streaming can produce updates far
   * faster than speech, and a screen reader that is interrupted every 80ms
   * reads nothing at all. Default 500.
   */
  announceThrottleMs?: number;
}

export function WeftProvider({
  children,
  announceThrottleMs = 500,
}: WeftProviderProps) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");

  const queue = useRef<{ message: string; politeness: Politeness }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAt = useRef(0);

  const drain = useCallback(() => {
    timer.current = null;
    const next = queue.current.shift();
    if (!next) return;
    lastAt.current = Date.now();

    // Setting the same string twice does not re-announce, so a marker character
    // is toggled to force it. U+2060 is a word joiner: zero width, no effect on
    // pronunciation.
    const bump = (prev: string) =>
      prev.endsWith("⁠") ? next.message : next.message + "⁠";

    if (next.politeness === "assertive") setAssertive(bump);
    else setPolite(bump);

    if (queue.current.length > 0) {
      timer.current = setTimeout(drain, announceThrottleMs);
    }
  }, [announceThrottleMs]);

  const announce = useCallback(
    (message: string, politeness: Politeness = "polite") => {
      const trimmed = message.trim();
      if (!trimmed) return;
      queue.current.push({ message: trimmed, politeness });
      if (timer.current) return;
      const elapsed = Date.now() - lastAt.current;
      const wait = Math.max(0, announceThrottleMs - elapsed);
      timer.current = setTimeout(drain, wait);
    },
    [announceThrottleMs, drain],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const value = useMemo<Announcer>(() => ({ announce }), [announce]);

  return (
    <AnnouncerContext.Provider value={value}>
      {children}
      {/* Mounted at load, always, empty until something has to be said. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        role="status"
        style={VISUALLY_HIDDEN}
      >
        {polite}
      </div>
      <div
        aria-live="assertive"
        aria-atomic="true"
        role="alert"
        style={VISUALLY_HIDDEN}
      >
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  );
}

export function useHasWeftProvider(): boolean {
  return useContext(AnnouncerContext) !== null;
}
