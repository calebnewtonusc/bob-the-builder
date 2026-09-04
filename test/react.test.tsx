/**
 * @vitest-environment jsdom
 *
 * The React layer had no tests at all in the first cut, which was the single
 * largest gap in the repo: every claim the README makes about rendering was
 * unverified. These cover the ones that would be embarrassing to get wrong.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import { z } from "zod";
import { defineCatalog, defineComponent } from "../src/core/catalog.js";
import type { Spec } from "../src/core/spec.js";
import { BobProvider } from "../src/react/live-region.js";
import { BobSurface, type ComponentMap } from "../src/react/surface.js";
import { BobSandbox } from "../src/react/sandbox.js";

afterEach(cleanup);

const catalog = defineCatalog({
  name: "react-test",
  components: {
    Stack: defineComponent({
      props: z.object({ gap: z.number().optional() }),
      describe: "Layout container holding a group of children.",
      a11y: { role: "group", name: { from: "none" } },
      skeleton: { shape: "none" },
    }),
    Text: defineComponent({
      props: z.object({ value: z.string() }),
      describe: "A paragraph of prose content.",
      a11y: { name: { from: "children" } },
      skeleton: { shape: "text", lines: 1 },
      children: [],
    }),
    Button: defineComponent({
      props: z.object({ label: z.string().min(1), action: z.string() }),
      describe: "Fires a named action back at the agent.",
      a11y: { role: "button", name: { from: "prop", prop: "label" }, keyboard: true },
      skeleton: { shape: "block" },
      children: [],
    }),
  },
  actions: { go: { describe: "Do the thing." } },
});

const components: ComponentMap<typeof catalog.components> = {
  Stack: ({ children }) => <div data-testid="stack">{children}</div>,
  Text: ({ value }) => <p>{value}</p>,
  Button: ({ label, action, onAction }) => (
    <button onClick={() => onAction(action)}>{label}</button>
  ),
};

function spec(partial: Partial<Spec>): Spec {
  return { root: null, elements: {}, data: {}, ...partial };
}

function renderSurface(s: Spec, extra: Record<string, unknown> = {}) {
  return render(
    <BobProvider>
      <BobSurface spec={s} catalog={catalog} components={components} {...extra} />
    </BobProvider>,
  );
}

describe("BobSurface", () => {
  it("renders a resolved tree", () => {
    renderSurface(
      spec({
        root: "page",
        elements: {
          page: { id: "page", type: "Stack", props: {}, children: ["a", "b"] },
          a: { id: "a", type: "Text", props: { value: "first" }, children: [] },
          b: { id: "b", type: "Text", props: { value: "second" }, children: [] },
        },
      }),
    );
    expect(screen.getByText("first")).toBeDefined();
    expect(screen.getByText("second")).toBeDefined();
  });

  it("renders the fallback and nothing else before ready", () => {
    renderSurface(
      spec({
        root: "page",
        elements: {
          page: { id: "page", type: "Stack", props: {}, children: ["a"] },
          a: { id: "a", type: "Text", props: { value: "leaked" }, children: [] },
        },
      }),
      { ready: false, fallback: <span>thinking</span> },
    );
    expect(screen.getByText("thinking")).toBeDefined();
    expect(screen.queryByText("leaked")).toBeNull();
  });

  it("renders a skeleton for a child that has not arrived", () => {
    const { container } = renderSurface(
      spec({
        root: "page",
        elements: {
          page: { id: "page", type: "Stack", props: {}, children: ["late"] },
        },
      }),
    );
    expect(container.querySelector("[data-bob-skeleton]")).not.toBeNull();
  });

  it("renders the same output twice under StrictMode", () => {
    // The first implementation kept a spec-scoped Set and mutated it during
    // render, so a development double-render found it already full and drew
    // nothing. This is that regression.
    const s = spec({
      root: "page",
      elements: {
        page: { id: "page", type: "Stack", props: {}, children: ["a"] },
        a: { id: "a", type: "Text", props: { value: "survives" }, children: [] },
      },
    });
    render(
      <StrictMode>
        <BobProvider>
          <BobSurface spec={s} catalog={catalog} components={components} />
        </BobProvider>
      </StrictMode>,
    );
    expect(screen.getByText("survives")).toBeDefined();
  });

  it("renders a shared child under both of its parents", () => {
    // A DAG is legal: two sections can both show the same summary component.
    // A global seen-set silently dropped the second one.
    renderSurface(
      spec({
        root: "page",
        elements: {
          page: { id: "page", type: "Stack", props: {}, children: ["l", "r"] },
          l: { id: "l", type: "Stack", props: {}, children: ["shared"] },
          r: { id: "r", type: "Stack", props: {}, children: ["shared"] },
          shared: { id: "shared", type: "Text", props: { value: "both" }, children: [] },
        },
      }),
    );
    expect(screen.getAllByText("both")).toHaveLength(2);
  });

  it("cuts a genuine cycle without hanging", () => {
    renderSurface(
      spec({
        root: "a",
        elements: {
          a: { id: "a", type: "Stack", props: {}, children: ["b"] },
          b: { id: "b", type: "Stack", props: {}, children: ["a"] },
        },
      }),
    );
    expect(screen.getAllByTestId("stack").length).toBeGreaterThan(0);
  });

  it("resolves a bound prop against the data model", () => {
    renderSurface(
      spec({
        root: "a",
        elements: {
          a: { id: "a", type: "Text", props: { value: { $bind: "/msg" } }, children: [] },
        },
        data: { msg: "from data" },
      }),
    );
    expect(screen.getByText("from data")).toBeDefined();
  });

  it("fires an action the catalog declares and ignores one it does not", () => {
    const onAction = vi.fn();
    render(
      <BobProvider>
        <BobSurface
          spec={spec({
            root: "p",
            elements: {
              p: { id: "p", type: "Stack", props: {}, children: ["ok", "bad"] },
              ok: { id: "ok", type: "Button", props: { label: "Go", action: "go" }, children: [] },
              bad: { id: "bad", type: "Button", props: { label: "Nope", action: "nope" }, children: [] },
            },
          })}
          catalog={catalog}
          components={components}
          onAction={onAction}
        />
      </BobProvider>,
    );
    act(() => {
      screen.getByText("Go").click();
    });
    expect(onAction).toHaveBeenCalledWith("go", undefined);

    onAction.mockClear();
    act(() => {
      screen.getByText("Nope").click();
    });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("skips a component the map does not provide", () => {
    render(
      <BobProvider>
        <BobSurface
          spec={spec({
            root: "p",
            elements: {
              p: { id: "p", type: "Stack", props: {}, children: ["x"] },
              x: { id: "x", type: "Text", props: { value: "hi" }, children: [] },
            },
          })}
          catalog={catalog}
          components={{ Stack: components.Stack }}
        />
      </BobProvider>,
    );
    expect(screen.queryByText("hi")).toBeNull();
  });
});

describe("BobProvider live regions", () => {
  it("mounts both live regions at load, before anything announces", () => {
    // The whole point: a region injected later is ignored by several screen
    // readers, so they have to exist in the initial DOM, empty.
    const { container } = render(
      <BobProvider>
        <div>content</div>
      </BobProvider>,
    );
    const polite = container.querySelector('[aria-live="polite"]');
    const assertive = container.querySelector('[aria-live="assertive"]');
    expect(polite).not.toBeNull();
    expect(assertive).not.toBeNull();
    expect(polite?.textContent).toBe("");
    expect(assertive?.textContent).toBe("");
  });

  it("keeps live regions in the DOM when the surface is empty", () => {
    const { container } = renderSurface(spec({}), { ready: false });
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});

describe("BobSandbox", () => {
  /**
   * The security-critical line in the whole library, and it was untested.
   * `allow-scripts` together with `allow-same-origin` is a sandbox escape: the
   * framed script can reach the parent document or delete its own sandbox
   * attribute. These assertions exist so nobody can add that flag by accident.
   */
  it("never sets allow-same-origin", () => {
    const { container } = render(<BobSandbox html="<p>hi</p>" title="t" />);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("never sets allow-same-origin even with scripts enabled", () => {
    const { container } = render(
      <BobSandbox html="<p>hi</p>" title="t" allowScripts />,
    );
    const sandbox = container.querySelector("iframe")!.getAttribute("sandbox")!;
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("never allows top navigation, which would enable frame busting", () => {
    const { container } = render(<BobSandbox html="<p>hi</p>" title="t" />);
    const sandbox = container.querySelector("iframe")!.getAttribute("sandbox")!;
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-downloads");
  });

  it("does not enable scripts by default", () => {
    const { container } = render(<BobSandbox html="<p>hi</p>" title="t" />);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");
  });

  it("carries an accessible name", () => {
    const { container } = render(
      <BobSandbox html="<p>hi</p>" title="Revenue chart" />,
    );
    expect(container.querySelector("iframe")!.getAttribute("title")).toBe(
      "Revenue chart",
    );
  });
});
