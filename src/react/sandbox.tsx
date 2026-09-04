/**
 * The escape hatch, for the one subtree that genuinely needs model-authored
 * markup. Read this whole comment before using it.
 *
 * An iframe carrying both `allow-scripts` and `allow-same-origin` is not
 * sandboxed. Together those two let the framed script reach the parent document
 * or simply remove its own `sandbox` attribute, and the combination appears
 * constantly in tutorials because each flag looks individually reasonable. Model
 * output rendered that way is a prompt-injection payload with a render target.
 *
 * So the inner frame here never gets `allow-same-origin`, which also costs it
 * cookies, localStorage, sessionStorage and IndexedDB, and never gets either
 * top-navigation flag, which is what stops frame-busting and popup-based
 * exfiltration. The security is in what is absent.
 *
 * Two further notes on cost, because this is not free:
 *
 *   Open-ended generation runs several times the tokens of the same screen
 *   declared through a catalog, and full-page regeneration has been reported at
 *   one to five minutes and roughly 220k tokens per session. Use this for a card
 *   inside a catalog-rendered page, never as the page.
 *
 *   Nothing in here is auditable by `weft audit`. A catalog is finite and can be
 *   checked once; generated HTML cannot. Content rendered through this component
 *   is outside every accessibility and design guarantee the rest of Weft makes.
 */

import { useEffect, useMemo, useRef } from "react";

export interface SandboxProps {
  /** Model-authored HTML. Treated as hostile. */
  html: string;
  title: string;
  height?: number | string;
  /**
   * Extra CSP source expressions for the frame document. The default policy
   * allows inline styles and nothing else: no scripts from anywhere, no network.
   */
  csp?: string;
  /**
   * Allow scripts inside the frame. Off by default. Turning this on is still
   * safe against parent-DOM access because `allow-same-origin` stays absent, but
   * it does let generated code run, so leave it off unless the content needs it.
   */
  allowScripts?: boolean;
  onMessage?: (data: unknown) => void;
}

const DEFAULT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;";

export function WeftSandbox({
  html,
  title,
  height = 320,
  csp = DEFAULT_CSP,
  allowScripts = false,
  onMessage,
}: SandboxProps) {
  const ref = useRef<HTMLIFrameElement>(null);

  const srcDoc = useMemo(() => {
    const policy = allowScripts ? csp.replace("default-src 'none';", "default-src 'none'; script-src 'unsafe-inline';") : csp;
    return [
      "<!doctype html><html><head><meta charset=\"utf-8\">",
      `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
      "<style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:CanvasText;background:Canvas}</style>",
      "</head><body>",
      html,
      "</body></html>",
    ].join("");
  }, [html, csp, allowScripts]);

  useEffect(() => {
    if (!onMessage) return;
    const handler = (event: MessageEvent) => {
      // A frame with no `allow-same-origin` posts from the opaque origin "null".
      // Anything claiming a real origin is not our frame.
      if (event.source !== ref.current?.contentWindow) return;
      if (event.origin !== "null") return;
      onMessage(event.data);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onMessage]);

  const sandbox = ["allow-forms", "allow-popups", "allow-modals"];
  if (allowScripts) sandbox.unshift("allow-scripts");
  // Deliberately never present: allow-same-origin, allow-top-navigation,
  // allow-top-navigation-by-user-activation, allow-downloads.

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={srcDoc}
      sandbox={sandbox.join(" ")}
      referrerPolicy="no-referrer"
      loading="lazy"
      style={{ width: "100%", height, border: 0, display: "block" }}
    />
  );
}
