import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { StatusBar } from "../ui/components/status-bar.js";
import { TurnPresenter } from "../ui/turn-presenter.js";
import { stripAnsi } from "./test-terminal.js";

function setup(): {
  presenter: TurnPresenter;
  transcript: Container;
  statusBar: StatusBar;
  rendered: () => string;
  status: () => string;
  renders: { count: number };
} {
  const transcript = new Container();
  const statusBar = new StatusBar();
  const renders = { count: 0 };
  const presenter = new TurnPresenter({
    transcript,
    statusBar,
    requestRender: () => {
      renders.count += 1;
    },
    flushIntervalMs: 0,
  });
  return {
    presenter,
    transcript,
    statusBar,
    renders,
    rendered: () => stripAnsi(transcript.render(80).join("\n")),
    status: () => stripAnsi(statusBar.render(80).join("\n")),
  };
}

describe("TurnPresenter", () => {
  it("renders streamed text, thinking, tool lifecycle, and telemetry in order", async () => {
    const { presenter, rendered, status } = setup();

    await presenter.event({ type: "provider_status", kind: "request_started", model: "claude-fable-5" });
    await presenter.event({ type: "assistant_thought", text: "I should list the files. " });
    await presenter.event({ type: "assistant_thought", text: "Then answer." });
    await presenter.event({ type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } });
    await presenter.event({ type: "tool_call_progress", id: "t1", partialResult: "a.txt\nb.txt\n" });
    await presenter.event({
      type: "tool_call_completed",
      id: "t1",
      content: "a.txt\nb.txt",
      isError: false,
      executionMs: 42,
    });
    await presenter.event({
      type: "usage_update",
      cumulativeUsd: 0.012,
      tokens: { input: 900, output: 40, cacheRead: 100, cacheCreation: 0 },
      model: "claude-fable-5",
    });
    await presenter.append("There are ");
    await presenter.append("two files.");
    await presenter.finish("There are two files.");
    presenter.settle();

    const text = rendered();
    // Thinking collapsed to a summary by default.
    expect(text).toContain("thought (");
    expect(text).not.toContain("I should list the files");
    // Tool panel with name, args preview, timing, result.
    expect(text).toContain("✓ bash");
    expect(text).toContain("42ms");
    expect(text).toContain("a.txt");
    // Streamed answer once (no duplication after finish reconciliation).
    expect(text.match(/two files\./gu)?.length).toBe(1);
    // Order: thinking before tool before answer.
    expect(text.indexOf("thought")).toBeLessThan(text.indexOf("✓ bash"));
    expect(text.indexOf("✓ bash")).toBeLessThan(text.indexOf("two files."));
    // Telemetry landed on the status bar.
    expect(status()).toContain("↑900");
    expect(status()).toContain("$0.012");
  });

  it("expands thinking on demand with the full text", async () => {
    const { presenter, transcript, rendered } = setup();
    await presenter.event({ type: "assistant_thought", text: "secret reasoning here" });
    presenter.settle();

    expect(rendered()).not.toContain("secret reasoning here");
    for (const child of transcript.children) {
      (child as { setExpanded?: (expanded: boolean) => void }).setExpanded?.(true);
    }
    expect(rendered()).toContain("secret reasoning here");
  });

  it("splits assistant text at tool boundaries and keeps chronology", async () => {
    const { presenter, rendered } = setup();
    await presenter.append("Let me check.");
    await presenter.event({ type: "tool_call_started", id: "t1", name: "read_file" });
    await presenter.event({ type: "tool_call_completed", id: "t1", content: "data" });
    await presenter.append("Done: 42.");
    await presenter.finish("Let me check.Done: 42.");
    presenter.settle();

    const text = rendered();
    expect(text.indexOf("Let me check.")).toBeLessThan(text.indexOf("read_file"));
    expect(text.indexOf("read_file")).toBeLessThan(text.indexOf("Done: 42."));
    expect(text.match(/Let me check\./gu)?.length).toBe(1);
    expect(text.match(/Done: 42\./gu)?.length).toBe(1);
  });

  it("shows finalText exactly once when nothing streamed (finalOnly runs)", async () => {
    const { presenter, rendered } = setup();
    await presenter.finish("The complete answer.");
    presenter.settle();

    expect(rendered().match(/The complete answer\./gu)?.length).toBe(1);
  });

  it("collapses to finalText when the stream diverged", async () => {
    const { presenter, rendered } = setup();
    await presenter.append("partial garbage");
    await presenter.finish("Clean final answer.");
    presenter.settle();

    const text = rendered();
    expect(text).toContain("Clean final answer.");
    expect(text).not.toContain("partial garbage");
  });

  it("renders warnings and failover notices inline", async () => {
    const { presenter, rendered, status } = setup();
    await presenter.event({ type: "runtime_warning", message: "context compaction imminent" });
    await presenter.event({ type: "provider_status", kind: "failover_started", from: "gpt-5.5", to: "kimi" });
    await presenter.event({ type: "provider_status", kind: "failover_completed", model: "kimi" });

    expect(rendered()).toContain("context compaction imminent");
    expect(rendered()).toContain("failover gpt-5.5 → kimi");
    expect(status()).toContain("answered by kimi");
  });

  it("ignores unknown event types (forward compatibility)", async () => {
    const { presenter, rendered } = setup();
    await presenter.event({ type: "quantum_flux", level: 9 } as never);
    await presenter.append("still fine");
    presenter.settle();

    expect(rendered()).toContain("still fine");
  });

  it("surfaces stream status and memory recall on the status bar", async () => {
    const { presenter, status } = setup();
    await presenter.status("Thinking…");
    expect(status()).toContain("Thinking…");
    await presenter.event({ type: "memory_recalled", source: "bujo", bytes: 2048 });
    expect(status()).toContain("memory recalled 2.0KB");
  });
});
