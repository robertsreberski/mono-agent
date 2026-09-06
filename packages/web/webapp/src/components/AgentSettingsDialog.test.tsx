import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent } from "../test/fixtures";

const storeMock = vi.hoisted(() => ({
  selectedAgent: null as ReturnType<typeof agent> | null,
  catalogByProvider: {},
  ensureProviderCatalog: vi.fn(),
  setAgentRunDefaults: vi.fn(),
  clearAgentRunDefaults: vi.fn(),
}));

vi.mock("../console-store", () => ({ useConsoleStore: () => storeMock }));
vi.mock("./assistant-ui/ModelSelector", () => ({
  ModelSelector: ({ onValueChange, onEffortChange }: {
    readonly onValueChange: (value: string) => void;
    readonly onEffortChange: (value: string) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onValueChange("provider/other")}>Choose other model</button>
      <button type="button" onClick={() => onEffortChange("high")}>Choose high effort</button>
    </div>
  ),
}));

import { AgentSettingsDialog } from "./AgentSettingsDialog";

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.selectedAgent = agent("alpha", {
    label: "Alpha",
    models: ["provider/model", "provider/other"],
    modelOptions: {
      "provider/model": { effortLevels: ["low", "high"] },
      "provider/other": { effortLevels: ["low", "high"] },
    },
  });
  storeMock.setAgentRunDefaults.mockResolvedValue(undefined);
  storeMock.clearAgentRunDefaults.mockResolvedValue(undefined);
});

describe("AgentSettingsDialog", () => {
  it("labels current config sources and saves only future-conversation defaults", async () => {
    const close = vi.fn();
    render(<AgentSettingsDialog open onClose={close} dialogRef={createRef<HTMLElement>()} />);

    expect(screen.getByRole("dialog", { name: "Alpha settings" })).toBeVisible();
    expect(screen.getByText(/Existing conversations and other channels are unchanged/u)).toBeVisible();
    expect(screen.getAllByText("config")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Choose other model" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose high effort" }));
    fireEvent.click(screen.getByRole("button", { name: "Save for new conversations" }));

    await vi.waitFor(() => {
      expect(storeMock.setAgentRunDefaults).toHaveBeenCalledWith("provider/other", "high");
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it("reverts an active override with one click", async () => {
    storeMock.selectedAgent = agent("alpha", {
      label: "Alpha",
      runSettings: {
        config: { model: "provider/model", effort: "low" },
        override: { model: "provider/other", effort: "high" },
        effective: {
          model: "provider/other",
          modelSource: "override",
          effort: "high",
          effortSource: "override",
        },
      },
    });
    render(<AgentSettingsDialog open onClose={vi.fn()} dialogRef={createRef<HTMLElement>()} />);

    fireEvent.click(screen.getByRole("button", { name: "Revert to config" }));

    await vi.waitFor(() => expect(storeMock.clearAgentRunDefaults).toHaveBeenCalledOnce());
  });
});
