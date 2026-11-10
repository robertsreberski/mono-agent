import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { TOOL_IMAGE } from "../test/tool-image-fixture";
import { ToolFallback } from "./Messages";
import { ActivityPayload, ActivityStep } from "./ActivityRow";
import { ToolCallRepairProvider } from "./tool-call-repair";
import { MAX_TOOL_IMAGE_RESULT_CHARS } from "./tool-result-images";
import "../styles.css";

// Valid JSON whitespace puts the image bytes beyond the service's 4,096-char
// preview without checking a large binary fixture into the repository.
const whole = `{"type":"image","mimeType":"image/png",${" ".repeat(4200)}"data":"${TOOL_IMAGE.data}"}`
  + "\n" + "Synthetic context. ".repeat(1500);
const repairPath = "/api/v1/threads/synthetic/messages/message/tool-calls/read-image";
function Example({ result = whole, truncated = false, characters = whole.length }: {
  readonly result?: unknown; readonly truncated?: boolean; readonly characters?: number;
}) {
  const [full, setFull] = useState<unknown>();
  const repaired = full !== undefined;
  return <main style={{ maxWidth: 760, margin: "auto", padding: 16 }}>
    <h1>Tool image preview</h1>
    <ToolCallRepairProvider repair={async (id) => {
      const part = await api.toolCallPart("synthetic", "message", id);
      if (part.type !== "tool-call") return false;
      setFull(part.result);
      return true;
    }}>
      <ToolFallback type="tool-call" toolName="Read" toolCallId="read-image" args={{ file_path: "pictures/synthetic.png" }}
        argsText={'{"file_path":"pictures/synthetic.png"}'} result={repaired ? full : result}
        addResult={() => undefined} resume={() => undefined} respondToApproval={() => undefined}
        status={{ type: "complete" }} artifact={truncated && !repaired ? { resultTruncated: true, resultBytes: characters } : {}} />
    </ToolCallRepairProvider>
  </main>;
}
afterEach(() => vi.unstubAllGlobals());

it.each([[390, 844], [1440, 1000]])("previews inline and repaired images at %i x %i", async (width, height) => {
  await page.viewport(width, height);
  const inline = render(<Example result={JSON.stringify(TOOL_IMAGE)} />);
  expect(screen.queryByRole("img")).toBeNull();
  await page.getByText("Read", { exact: true }).click();
  const image = await screen.findByRole("img", { name: "synthetic.png" });
  await waitFor(() => expect((image as HTMLImageElement).naturalWidth).toBe(320));
  await page.getByRole("button", { name: "View synthetic.png" }).click();
  expect(await screen.findByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close image" }).click();
  expect(screen.queryByText(TOOL_IMAGE.data, { exact: false })).toBeNull();
  inline.unmount();

  let respond: ((response: Response) => void) | undefined;
  const fetchOriginal = globalThis.fetch;
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith(repairPath)
    ? new Promise<Response>((resolve) => { respond = resolve; }) : fetchOriginal(input, init));
  vi.stubGlobal("fetch", fetcher);
  render(<Example truncated result={whole.slice(0, 4_096)} />);
  // Let intersection/toggle delivery settle: a collapsed row must never fetch.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(fetcher).not.toHaveBeenCalled();
  await page.getByText("Read", { exact: true }).click();
  expect(await screen.findByText("Loading image output…")).toBeVisible();
  await waitFor(() => expect(respond).toBeDefined());
  respond!(new Response(JSON.stringify({ part: { type: "tool-call", toolCallId: "read-image", toolName: "Read", result: whole, status: "complete" } }), { headers: { "content-type": "application/json" } }));
  const repairedImage = await screen.findByRole("img", { name: "synthetic.png" });
  await waitFor(() => expect((repairedImage as HTMLImageElement).naturalWidth).toBe(320));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Synthetic context/)).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const bounds = repairedImage.getBoundingClientRect();
  expect(bounds.height).toBeLessThanOrEqual(240);
  expect(bounds.width).toBeLessThanOrEqual(width);
  const shots = import.meta.env.VITE_TOOL_IMAGE_SHOTS;
  if (typeof shots === "string") await page.screenshot({ path: `${shots}/tool-image-expanded-${width}x${height}.png` });
});

it("renders a JPEG returned inline by any tool", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 4; canvas.height = 4;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#2a7d8c"; context.fillRect(0, 0, 4, 4);
  const jpeg = { type: "image", mimeType: "image/jpeg", data: canvas.toDataURL("image/jpeg").split(",")[1] };
  render(<Example result={{ content: [jpeg, { type: "text", text: "Synthetic JPEG" }] }} />);
  await page.getByText("Read", { exact: true }).click();
  const image = await screen.findByRole("img");
  await waitFor(() => expect((image as HTMLImageElement).naturalWidth).toBe(4));
  expect(screen.getByText(/Synthetic JPEG/)).toBeVisible();
});

it("keeps text and retry controls when lazy repair fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
  render(<Example truncated result={whole.slice(0, 4_096)} />);
  await page.getByText("Read", { exact: true }).click();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load image output");
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("button", { name: "Load full output" })).toBeVisible();
  expect(screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent?.includes("mimeType") === true)).toBeVisible();
});

it("falls back to original text for a raster that fails browser decoding", async () => {
  const bytes = atob(TOOL_IMAGE.data).slice(0, 33); // valid small header, missing pixels
  render(<Example result={JSON.stringify({ ...TOOL_IMAGE, data: btoa(bytes) })} />);
  await page.getByText("Read", { exact: true }).click();
  expect(await screen.findByText(/Image preview unavailable/)).toBeVisible();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent?.includes(btoa(bytes)) === true)).toBeVisible();
});

it("does not automatically fetch oversized results or change non-image output", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const huge = render(<Example truncated characters={MAX_TOOL_IMAGE_RESULT_CHARS + 1} result={whole.slice(0, 100)} />);
  await page.getByText("Read", { exact: true }).click();
  expect(screen.getByRole("button", { name: "Load full output" })).toBeVisible();
  expect(fetcher).not.toHaveBeenCalled();
  huge.unmount();
  render(<Example result="Ordinary output" />);
  await page.getByText("Read", { exact: true }).click();
  expect(screen.getByText('"Ordinary output"')).toBeVisible();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
});

it("waits for nested disclosures and viewport visibility before repairing", async () => {
  await page.viewport(390, 844);
  const repair = vi.fn(async () => false);
  render(<div style={{ paddingTop: 1200 }}>
    <details><summary>Read cluster</summary>
      <ActivityStep toolName="Read" defaultOpen>
        <ActivityPayload args={{ path: "synthetic.png" }} result={whole.slice(0, 100)}
          resultTruncated resultBytes={whole.length} onLoadFull={repair} />
      </ActivityStep>
    </details>
  </div>);
  const summary = screen.getByText("Read cluster");
  summary.click(); // Open, but still offscreen.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(repair).not.toHaveBeenCalled();
  summary.scrollIntoView();
  await waitFor(() => expect(repair).toHaveBeenCalledTimes(1));
});

it("keeps a seen preview mounted while scrolling out of view and back", async () => {
  await page.viewport(390, 844);
  render(<>
    <Example result={JSON.stringify(TOOL_IMAGE)} />
    <div style={{ height: 1600 }} />
  </>);
  await page.getByText("Read", { exact: true }).click();
  const image = await screen.findByRole("img", { name: "synthetic.png" });
  await waitFor(() => expect((image as HTMLImageElement).naturalWidth).toBe(320));
  window.scrollTo(0, 1200);
  await waitFor(() => expect(image.getBoundingClientRect().bottom).toBeLessThan(0));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(document.querySelector(".tool-image-preview img")).toBe(image);
  expect(document.querySelector(".tool-image-output pre")).toBeNull();
  window.scrollTo(0, 0);
  await waitFor(() => expect(image.getBoundingClientRect().top).toBeGreaterThan(0));
  expect(screen.getByRole("img", { name: "synthetic.png" })).toBe(image);
  expect(document.querySelector(".tool-image-output pre")).toBeNull();
});

it("explains an image line cut before web persistence and keeps its raw output", async () => {
  await page.viewport(1440, 1000);
  // The operator frame cap can cut image JSON without web resultTruncated metadata.
  const cutImage = JSON.stringify(TOOL_IMAGE).slice(0, 120) + "\n[truncated]";
  render(<Example result={cutImage} />);
  await page.getByText("Read", { exact: true }).click();
  expect(await screen.findByRole("status")).toHaveTextContent("Image is too large, incomplete, or unsupported for preview");
  expect(screen.queryByRole("img")).toBeNull();
  expect(document.querySelector(".tool-image-output pre")?.textContent).toBe(JSON.stringify(cutImage));
  const shots = import.meta.env.VITE_TOOL_IMAGE_OVERSIZE_SHOTS;
  if (typeof shots === "string") await page.screenshot({ path: `${shots}/tool-image-unavailable-1440x1000.png` });
});
