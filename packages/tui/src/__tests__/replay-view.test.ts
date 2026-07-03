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

/** cron run identified by sourceDetail (job id); no userInput. Fixed clock => deterministic 0ms duration. */
async function writeCronFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "cron:1",
    artifactDir: dir,
    source: "cron",
    sourceDetail: "daily-digest",
    clock: () => 0,
  });
  await recorder.finish({ text: "ok" });
}

/** telegram run with no sourceDetail, identified by its userInput. Fixed clock => deterministic 0ms duration. */
async function writeUserInputFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "telegram:1",
    artifactDir: dir,
    userInput: "summarize my inbox",
    clock: () => 0,
  });
  await recorder.finish({
    text: "ok",
    model: "pi:openai:gpt-5.5",
    effort: "high",
    usage: { input: 1_200, output: 340 },
    cost: { totalUsd: 0.045 },
  });
}

/** slack run with neither sourceDetail nor userInput -- falls back to conversationId. */
async function writeBareFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "slack:7",
    artifactDir: dir,
    clock: () => 0,
  });
  await recorder.finish({ text: "ok" });
}

/** failed run (failureKind set, no error string) for status-filter coverage. */
async function writeFailedFixture(runId: string): Promise<void> {
  const recorder = createJsonlRunRecorder({
    runId,
    conversationId: "webhook:1",
    artifactDir: dir,
    clock: () => 0,
  });
  await recorder.finish({ text: "", failureKind: "provider_unavailable" });
}

describe("ReplayView list mode", () => {
  it("leads the label with sourceDetail (job id) over conversationId for a cron-sourced run", async () => {
    await writeCronFixture("run-cron");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();

    const text = renderText(view);
    expect(text).toContain("[cron] daily-digest");
    expect(text).not.toContain("cron:1");
  });

  it("falls back to a quoted, compacted userInput preview when sourceDetail is absent", async () => {
    await writeUserInputFixture("run-input");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();

    const text = renderText(view);
    expect(text).toContain('[telegram] "summarize my inbox"');
  });

  it("falls back to conversationId when neither sourceDetail nor userInput is present", async () => {
    await writeBareFixture("run-bare");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();

    const text = renderText(view);
    expect(text).toContain("[slack] slack:7");
  });

  it("description carries duration, event count, model@effort, and token usage", async () => {
    await writeUserInputFixture("run-input");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();

    const text = renderText(view);
    expect(text).toContain("0ms");
    expect(text).toContain("0 ev");
    expect(text).toContain("gpt-5.5@high");
    expect(text).toContain("↑1.2k ↓340");
    expect(text).toContain("$0.045");
  });

  it("`s` cycles the source filter (refetching, showing zero matches for an empty source, header reflects it) and back to all", async () => {
    await writeCronFixture("run-cron");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    expect(renderText(view)).toContain("[cron] daily-digest");

    // all -> tui (no tui runs recorded in this fixture dir).
    view.handleInput("s");
    await flush();
    let text = renderText(view);
    expect(text).toContain("source: tui");
    expect(text).not.toContain("daily-digest");

    // tui -> telegram -> slack -> cron -> webhook -> memory -> other -> all.
    for (let i = 0; i < 7; i += 1) {
      view.handleInput("s");
      await flush();
    }
    text = renderText(view);
    expect(text).not.toContain("source:");
    expect(text).toContain("daily-digest");
  });

  it("`x` cycles the status filter to failed-only, then succeeded, then back to all", async () => {
    await writeCronFixture("run-cron"); // succeeded
    await writeFailedFixture("run-failed");
    const view = setup();
    view.setArtifactDir(dir);
    await flush();
    expect(renderText(view)).toContain("(2/2)");

    view.handleInput("x"); // all -> failed
    let text = renderText(view);
    expect(text).toContain("status: failed");
    expect(text).toContain("(1/2)");
    expect(text).not.toContain("daily-digest");

    view.handleInput("x"); // failed -> succeeded
    text = renderText(view);
    expect(text).toContain("status: succeeded");
    expect(text).toContain("(1/2)");
    expect(text).toContain("daily-digest");

    view.handleInput("x"); // succeeded -> all
    text = renderText(view);
    expect(text).not.toContain("status:");
    expect(text).toContain("(2/2)");
  });
});

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
