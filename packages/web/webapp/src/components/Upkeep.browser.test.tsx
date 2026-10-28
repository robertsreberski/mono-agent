import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, expect, it, vi } from "vitest";
import { messageUsageRollup } from "../../../src/message-cost.js";
import { sumThreadUsage } from "../../../src/thread-usage.js";
import { convertWebMessage } from "../runtime";
import { ContextDisplay } from "./assistant-ui/ContextDisplay";
import { RunningSection } from "./dashboard/RunningSection";
import { AssistantMessage, UserMessage } from "./Messages";
import { agent, thread } from "../test/fixtures";
import type { WebMessage } from "../types";
import "../styles.css";

// All API access remains synthetic, including any lazy usage popup request.
vi.mock("../api", async original => ({ ...(await original<typeof import("../api")>()), api: { threadUsage: vi.fn() } }));
const shots = import.meta.env.VITE_UPKEEP_SHOTS as string | undefined;
const dispatch = { version: 1, usageIncluded: false, operationId: "fictional-operation", runId: "fictional-run", conversationId: "fictional-thread", model: "fictional:extractor-b", budget: "bootstrap", phase: "dispatch", invocation: "uncertain", outcome: "uncertain", inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null } as const;
const result = { ...dispatch, phase: "result", invocation: "invoked", outcome: "valid", inputTokens: 200, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 30, costUsd: 0.02 } as const;
const answerUsage = { type: "telemetry", event: "usage_update", data: { model: "fictional:answer-a", cumulativeUsd: 0.01, tokens: { input: 900, cacheRead: 100, cacheWrite: 0, output: 100 } } } as const;
function Fixture({ mode }: { readonly mode: string }) {
  const running = mode === "running", legacy = mode === "legacy";
  const message: WebMessage = { id: "fictional-answer", threadId: "fictional-thread", turnId: "fictional-turn", role: "assistant", status: running ? "running" : "complete", attachments: [], createdAt: "2026-05-17T10:00:00Z", updatedAt: "2026-05-17T10:00:01Z", parts: [
    { type: "text", text: "Morgan's fictional garden plan." }, answerUsage,
    ...(legacy ? [] : [{ type: "telemetry" as const, event: "runtime_telemetry", data: { kind: "continuity_upkeep", data: { accounting: mode === "known" ? result : mode === "partial" ? { ...result, costUsd: null, outputTokens: null } : dispatch } } }]),
  ] };
  const totals = sumThreadUsage([messageUsageRollup(message)], "2026-05-17T10:00:01Z");
  const runtime = useExternalStoreRuntime<WebMessage>({ messages: [message], convertMessage: value => convertWebMessage(value), onNew: async () => undefined });
  const owner = agent("fictional-agent", { label: "Garden assistant", defaultModel: "fictional:answer-a" });
  const rollup = messageUsageRollup(message);
  const active = thread("fictional-thread", owner.sourceId, { title: "Morgan's fictional garden", runState: { status: "running", activity: { toolCallCount: 0, phase: "working", cumulativeUsd: rollup.main.costUsd, knownCostUsd: rollup.main.knownCostUsd, ...(rollup.upkeep ? { upkeep: { ...rollup.upkeep, models: [dispatch.model] } } : {}) } } });
  return <div style={{ height: "100dvh", display: "flex", flexDirection: "column", padding: "16px", gap: "12px" }}>
    <h1 style={{ fontSize: "20px" }}>Synthetic continuity accounting</h1>
    {running && <RunningSection groups={[{ agent: owner, threads: [active] }]} expandedAgentIds={new Set()} onToggleAgent={() => {}} onOpen={() => {}} />}
    <div style={{ flex: 1, minHeight: 0 }}><AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="thread-root"><ThreadPrimitive.Viewport className="thread-viewport"><div className="message-column"><ThreadPrimitive.Messages components={{ AssistantMessage, UserMessage }} /></div></ThreadPrimitive.Viewport></ThreadPrimitive.Root></AssistantRuntimeProvider></div>
    <div style={{ position: "fixed", right: 16, bottom: 24 }}><ContextDisplay context={{ status: running ? "updating" : "current", usage: { total: 1200, contextWindow: 100000 } }} totals={totals} /></div>
  </div>;
}
afterEach(async () => { await page.viewport(1440, 900); });
it.each([[1440, 900, "desktop"], [390, 844, "mobile"]] as const)("shows once-only upkeep and preserves legacy UI at %s×%s", async (width, height, label) => {
  await page.viewport(width, height);
  for (const mode of ["known", "partial", "running", "legacy"]) {
    const view = render(<Fixture mode={mode} />);
    expect(await screen.findByText("Morgan's fictional garden plan.")).toBeVisible();
    if (mode !== "legacy") {
      const summary = screen.getByText(/^Message cost/u);
      expect(summary).toHaveTextContent(mode === "known" ? "$0.03" : "partial");
      fireEvent.click(summary);
      expect(screen.getByText(/extractor-b:/u)).toBeVisible();
    } else expect(screen.queryByText(/^Message cost/u)).not.toBeInTheDocument();
    if (mode === "running") {
      const card = screen.getByRole("button", { name: /Open Morgan's fictional garden/u });
      expect(card).toHaveTextContent(/Working… · ≥\$0.01 \(partial\)/u);
      expect(card).toHaveTextContent(/Continuity upkeep.*extractor-b.*cost pending/u);
      expect(card).not.toHaveTextContent("Known cost");
      expect(card).toHaveAccessibleDescription(/Working.*Continuity upkeep.*cost pending/u);
    } else {
      fireEvent.click(screen.getByRole("button", { name: /^Context usage:/u }));
      const dialog = await screen.findByRole("dialog", { name: "Context usage" });
      if (mode === "legacy") expect(dialog).not.toHaveTextContent("Continuity upkeep");
      else { expect(dialog).toHaveTextContent("Continuity upkeep"); expect(dialog).toHaveTextContent("extractor-b"); expect(dialog).toHaveTextContent("answer-a"); }
      if (mode === "partial") expect(dialog).toHaveTextContent("partial");
    }
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width));
    if (shots) await page.screenshot({ path: `${shots}/${mode}-${label}.png` });
    view.unmount();
  }
});

it("announces included upkeep and pending tokens/cost before the first result", async () => {
  const totals = sumThreadUsage([messageUsageRollup({ parts: [{ type: "telemetry", event: "runtime_telemetry", data: { kind: "continuity_upkeep", data: { accounting: dispatch } } }] })]);
  const view = render(<ContextDisplay context={{ status: "updating", usage: { total: 1, contextWindow: 100000 } }} totals={totals} />);
  fireEvent.click(screen.getByRole("button", { name: /^Context usage:/u }));
  const dialog = await screen.findByRole("dialog", { name: "Context usage" });
  expect(dialog).toHaveTextContent("pending");
  expect(screen.getByRole("row", { name: /Total pending/u })).toBeVisible();
  expect(screen.getByRole("row", { name: /incl. upkeep pending/u })).toBeVisible();
  expect(dialog).not.toHaveTextContent("≥0");
  expect(dialog).not.toHaveTextContent("≥$0.00");
  expect(dialog).not.toHaveTextContent("Known cost");
  expect(screen.getByText("(included in total)")).toBeInTheDocument();
  view.unmount();
});
