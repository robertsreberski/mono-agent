import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";

import { HistoryPane } from "../components/HistoryPane.js";
import { createInMemoryTuiHistory } from "../agent/history.js";
import type { TuiHistoryMessage } from "../agent/history.js";

afterEach(() => {
  cleanup();
});

const sleep = (ms = 20) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeMessage(
  overrides: Partial<TuiHistoryMessage> & Pick<TuiHistoryMessage, "id">,
): TuiHistoryMessage {
  return {
    role: "user",
    text: "hello",
    timestamp: Date.UTC(2026, 4, 16, 9, 0, 0),
    ...overrides,
  };
}

describe("HistoryPane", () => {
  it("renders the empty state when there are no messages", async () => {
    const history = createInMemoryTuiHistory();
    const { lastFrame } = render(<HistoryPane history={history} active />);
    await sleep();
    expect(lastFrame()).toMatch(/history is empty/);
  });

  it("renders message previews and highlights the selected row", async () => {
    const history = createInMemoryTuiHistory();
    history.append(makeMessage({ id: "1", text: "first message" }));
    history.append(
      makeMessage({ id: "2", role: "assistant", text: "second message" }),
    );
    const { lastFrame } = render(<HistoryPane history={history} active />);
    await sleep();
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/first message/);
    expect(frame).toMatch(/second message/);
    // Selection cursor renders as `›` next to the first row by default.
    expect(frame.split("\n").some((line) => line.includes("› "))).toBe(true);
  });

  it("opens detail on enter and returns to the list on escape", async () => {
    const history = createInMemoryTuiHistory();
    history.append(
      makeMessage({
        id: "1",
        text: "long body",
        metadata: { runtime: { model: "codex" } },
      }),
    );
    history.append(makeMessage({ id: "2", text: "second" }));
    const { stdin, lastFrame } = render(
      <HistoryPane history={history} active />,
    );
    await sleep();
    stdin.write("\r"); // enter on first row
    await sleep();
    expect(lastFrame() ?? "").toMatch(/long body/);
    expect(lastFrame() ?? "").toMatch(/metadata/);
    expect(lastFrame() ?? "").toMatch(/runtime/);
    stdin.write("\u001b"); // escape
    await sleep();
    expect(lastFrame() ?? "").toMatch(/long body/);
    expect(lastFrame() ?? "").toMatch(/second/);
    // After escape we should be back on the list (with the cursor marker).
    expect((lastFrame() ?? "").split("\n").some((line) => line.includes("› "))).toBe(true);
  });

  it("down arrow moves selection and del removes the highlighted message", async () => {
    const history = createInMemoryTuiHistory();
    history.append(makeMessage({ id: "1", text: "first" }));
    history.append(makeMessage({ id: "2", text: "second" }));
    history.append(makeMessage({ id: "3", text: "third" }));
    const { stdin } = render(<HistoryPane history={history} active />);
    await sleep();
    stdin.write("\u001b[B"); // down
    await sleep();
    stdin.write("\u007f"); // delete (DEL)
    await sleep();
    const ids = history.list().map((message) => message.id);
    expect(ids).toEqual(["1", "3"]);
  });

  it("falls back to empty state once everything is removed", async () => {
    const history = createInMemoryTuiHistory();
    history.append(makeMessage({ id: "1" }));
    const { stdin, lastFrame } = render(
      <HistoryPane history={history} active />,
    );
    await sleep();
    stdin.write("\u007f"); // remove the only row
    await sleep();
    expect(lastFrame() ?? "").toMatch(/history is empty/);
  });
});
