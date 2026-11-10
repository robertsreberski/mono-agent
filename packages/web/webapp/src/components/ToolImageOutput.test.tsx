import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TOOL_IMAGE } from "../test/tool-image-fixture";
import { ToolImageOutput } from "./ToolImageOutput";

afterEach(() => vi.unstubAllGlobals());

it.each(["array", "content"])("eagerly previews kind-only %s parts when IntersectionObserver is unavailable", async (shape) => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const raw = { kind: "image", mimeType: TOOL_IMAGE.mimeType, data: TOOL_IMAGE.data };
  const result = shape === "array" ? [raw] : { content: [raw] };
  render(<ToolImageOutput result={result} args={{ path: "synthetic.png" }} truncated={false} />);
  expect(await screen.findByRole("img", { name: "synthetic.png" }))
    .toHaveAttribute("src", `data:image/png;base64,${TOOL_IMAGE.data}`);
});
