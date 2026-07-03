import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TUI } from "@earendil-works/pi-tui";
import { createJsonlRunRecorder } from "@mono-agent/observability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReplayView } from "../ui/views/replay.js";
import { stripAnsi, TestTerminal } from "./test-terminal.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tui-replay-view-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(): ReplayView {
  const tui = new TUI(new TestTerminal(100, 30));
  return new ReplayView({ tui });
}

/** pi-tui coalesces nothing on its own render(); this just gives async fs reads a tick to settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function renderText(view: ReplayView): string {
  return stripAnsi(view.render(100).join("\n"));
}

async function openRun(view: ReplayView, runId: string): Promise<void> {
  view.list.onSelect?.({ value: runId, label: "", description: "" });
  await flush();
}

/**
 * Two turns: coalesced thinking -> tool_use ("bash") -> tool_result -> thinking
 * -> text (mentioning "bash" again, so search has 2 matches). summary carries
 * model/effort/source directly (no run_config fallback, no override).
 */
async function writeMultiTurnFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "telegram:1",
    artifactDir: dir,
    source: "telegram",
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { content: [{ type: "thinking", text: "let me think " }] },
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { content: [{ type: "thinking", text: "some more" }] },
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
  });
  recorder.onEvent({
    type: "user",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: { content: [{ type: "thinking", text: "done" }] },
  });
  recorder.onEvent({
    type: "assistant",
    timestamp: "2026-01-01T00:00:05.000Z",
    message: { content: [{ type: "text", text: "bash finished, final answer" }] },
  });
  await recorder.finish({ text: "bash finished, final answer", model: "claude-fable-5", effort: "high" });
}

/**
 * Pre-timestamp-stamping artifact: no ISO timestamps anywhere, no
 * summary.model/effort/source, but a `run_config` event with overridden:true
 * to fall back to. Hand-written after `finish()` (recorder.onEvent always
 * stamps a timestamp when one is absent), mirroring replay-data.test.ts's
 * "run-no-timestamps" pattern.
 */
async function writeOldStyleFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "slack:99",
    artifactDir: dir,
  });
  const summary = await recorder.finish({ text: "hello from the past" });
  const lines = [
    { type: "run_config", model: "model-old", effort: "medium", executionMode: "agentic", overridden: true },
    { type: "assistant", message: { content: [{ type: "text", text: "hello from the past" }] } },
  ];
  await writeFile(summary.artifactPaths[0] ?? "", `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

/** Single tool_use event with a payload big enough (>12 lines, <40) to exercise expand/collapse. */
async function writeBigPayloadFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "telegram:1",
    artifactDir: dir,
  });
  const bigInput = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key${i}`, `value-${i}`]));
  recorder.onEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: bigInput }] },
  });
  await recorder.finish({ text: "done" });
}

describe("ReplayView detail mode", () => {
  it("shows the headline with a source badge, model, and effort (no override marker) after opening a run", async () => {
    await writeMultiTurnFixture("run-a");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    const text = renderText(view);
    expect(text).toContain("run run-a");
    expect(text).toContain("[telegram]");
    expect(text).toContain("claude-fable-5");
    expect(text).toContain("effort:high");
    expect(text).not.toContain("(override)");
  });

  it("falls back to run_config for model/effort/source on an old (pre-timestamp) artifact, marking them as override, without crashing", async () => {
    await writeOldStyleFixture("run-old");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-old");

    const text = renderText(view);
    expect(text).toContain("[slack]"); // derived from conversationId, no persisted source
    expect(text).toContain("model-old");
    expect(text).toContain("effort:medium");
    expect(text).toContain("(override)");
    // No per-row clock/delta column anywhere (no item carries a timestamp).
    expect(text).not.toMatch(/\+\d+(ms|s)/u);
  });

  it("`t` filters to thinking-only rows and `a` restores; status line reflects the active filter", async () => {
    await writeMultiTurnFixture("run-a");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    view.handleInput("t");
    let text = renderText(view);
    expect(text).toContain("filters: thinking");
    expect(text).not.toContain("Tool:");

    view.handleInput("a");
    text = renderText(view);
    expect(text).not.toContain("filters:");
    expect(text).toContain("Tool:");
  });

  it("`]` jumps the selection to the next turn (status line reflects it)", async () => {
    await writeMultiTurnFixture("run-a");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    const before = renderText(view);
    expect(before).toContain("turn 1/2");

    view.handleInput("]");
    const after = renderText(view);
    expect(after).toContain("turn 2/2");
  });

  it("commits a search via / + typing + enter, jumps to a match, advances with n, and unwinds via esc layering (search -> collapse -> list)", async () => {
    await writeMultiTurnFixture("run-a");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    view.handleInput("/");
    for (const ch of "bash") {
      view.handleInput(ch);
    }
    expect(renderText(view)).toContain('search: "bash█"');
    view.handleInput("\x7f"); // backspace
    expect(renderText(view)).toContain('search: "bas█"');
    view.handleInput("h"); // retype -- back to "bash"

    view.handleInput("\r"); // commit
    let text = renderText(view);
    expect(text).toContain('search: "bash" (2 matches)');
    // Committing jumps the selection to a match: the tool_use item ("Tool: bash").
    expect(text).toContain("Tool: bash");

    view.handleInput("n"); // advance to the next match (the closing text item)
    text = renderText(view);
    expect(text).toContain("bash finished, final answer");

    // Set up the second esc-layer: expand the payload pane (enter, since
    // search input is no longer open here).
    view.handleInput("\r");

    // Layer 1: committed search clears first.
    expect(view.back()).toBe(true);
    expect(view.isInDetail()).toBe(true);
    expect(renderText(view)).not.toContain("search:");

    // Layer 2: payload expansion collapses next.
    expect(view.back()).toBe(true);
    expect(view.isInDetail()).toBe(true);

    // Layer 3: returns to the run list.
    expect(view.back()).toBe(true);
    expect(view.isInDetail()).toBe(false);

    // Already at the list -- back() is a no-op (existing behavior).
    expect(view.back()).toBe(false);
  });

  it("`enter` expands the payload pane, growing the rendered line count and dropping the truncation note", async () => {
    await writeBigPayloadFixture("run-big");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-big");

    const collapsed = view.render(100);
    const collapsedText = stripAnsi(collapsed.join("\n"));
    expect(collapsedText).toContain("more lines)");

    view.handleInput("\r");
    const expanded = view.render(100);
    const expandedText = stripAnsi(expanded.join("\n"));
    expect(expandedText).not.toContain("more lines)");
    expect(expanded.length).toBeGreaterThan(collapsed.length);
  });

  it("esc from plain detail (no search, no expansion) returns to the list (regression)", async () => {
    await writeMultiTurnFixture("run-a");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    await openRun(view, "run-a");

    expect(view.isInDetail()).toBe(true);
    expect(view.back()).toBe(true);
    expect(view.isInDetail()).toBe(false);
    expect(view.back()).toBe(false);
  });
});
