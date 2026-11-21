import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TOOL_IMAGE } from "../test/tool-image-fixture";
import { ToolImageOutput } from "./ToolImageOutput";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["array", "content"])("eagerly previews kind-only %s parts when IntersectionObserver is unavailable", async (shape) => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const raw = { kind: "image", mimeType: TOOL_IMAGE.mimeType, data: TOOL_IMAGE.data };
  const result = shape === "array" ? [raw] : { content: [raw] };
  render(<ToolImageOutput result={result} args={{ path: "synthetic.png" }} truncated={false} />);
  expect(await screen.findByRole("img", { name: "synthetic.png" }))
    .toHaveAttribute("src", `data:image/png;base64,${TOOL_IMAGE.data}`);
});

it("previews when a later entry in an observer batch is intersecting", async () => {
  let callback!: IntersectionObserverCallback;
  let observer!: IntersectionObserver;
  const disconnect = vi.fn();
  class StubIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds = [];
    constructor(onIntersect: IntersectionObserverCallback) {
      callback = onIntersect;
      observer = this;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect = disconnect;
    takeRecords(): IntersectionObserverEntry[] { return []; }
  }
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  const view = render(<ToolImageOutput result={JSON.stringify(TOOL_IMAGE)} args={{ path: "synthetic.png" }} truncated={false} />);
  const target = view.container.firstElementChild!;
  const entry = (isIntersecting: boolean) => ({ target, isIntersecting }) as IntersectionObserverEntry;
  act(() => callback([entry(false)], observer));
  expect(screen.queryByRole("img")).toBeNull();
  expect(disconnect).not.toHaveBeenCalled();

  // A delayed delivery can batch the initial offscreen state with a later intersection.
  act(() => callback([entry(false), entry(true)], observer));
  expect(await screen.findByRole("img", { name: "synthetic.png" }))
    .toHaveAttribute("src", `data:image/png;base64,${TOOL_IMAGE.data}`);
  expect(disconnect).toHaveBeenCalled();
});

it("validates only when member results change, not when their array or fallback text changes", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const first = JSON.stringify(TOOL_IMAGE);
  const second = { content: [TOOL_IMAGE] };
  const decode = vi.spyOn(globalThis, "atob");
  const view = render(<ToolImageOutput result="joined results" imageResults={[first, second]} args={{}} truncated={false} />);
  expect(await screen.findAllByRole("img")).toHaveLength(2);
  expect(decode).toHaveBeenCalledTimes(2);
  view.rerender(<ToolImageOutput result="updated fallback text" imageResults={[first, second]} args={{}} truncated={false} />);
  expect(screen.getAllByRole("img")).toHaveLength(2);
  expect(decode).toHaveBeenCalledTimes(2);
  view.rerender(<ToolImageOutput result="changed member" imageResults={[first, `updated caption\n${first}`]} args={{}} truncated={false} />);
  expect(screen.getByText(/updated caption/)).toBeInTheDocument();
  expect(decode).toHaveBeenCalledTimes(4);
});
