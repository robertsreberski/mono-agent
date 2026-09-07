import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { convertWebMessage } from "../runtime";
import type { WebMessage } from "../types";
import "../styles.css";
import { AssistantMessage, SystemMessage, UserMessage } from "./Messages";

vi.mock("../console-store", () => ({
  useConsoleStore: () => ({
    connection: "live",
    effectiveModel: "provider:primary",
    loadCronRunActivity: vi.fn(),
    selectedAgent: null,
    selectedThread: null,
    transcriptMovedAt: 0,
  }),
  useUploadLimits: () => ({
    maxFileBytes: 20,
    maxFilesPerTurn: 10,
    maxTurnBytes: 100,
    accept: ["image/png"],
  }),
}));

const message = (id: string, liveInputStatus: "applied" | "uncertain"): WebMessage => ({
  id,
  threadId: "thread",
  role: "user",
  createdAt: "2026-09-07T10:00:00.000Z",
  updatedAt: "2026-09-07T10:00:00.000Z",
  status: "complete",
  liveInputStatus,
  attachments: [],
  parts: [{ type: "text", text: `Follow-up ${id}` }],
});

function Harness({ width }: { readonly width: number }) {
  const runtime = useExternalStoreRuntime<WebMessage>({
    messages: [message("consumed", "applied"), message("uncertain", "uncertain")],
    convertMessage: (value) => convertWebMessage(value, { selectedModel: "provider:primary" }),
    onNew: async () => undefined,
    adapters: {
      threadList: {
        threadId: "thread",
        isLoading: false,
        threads: [{ id: "thread", remoteId: "thread", status: "regular" }],
        archivedThreads: [],
        onSwitchToNewThread: async () => undefined,
        onSwitchToThread: () => undefined,
        onRename: async () => undefined,
        onArchive: async () => undefined,
        onUnarchive: async () => undefined,
      },
    },
  });
  return (
    <div style={{ width, minHeight: 320 }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages components={{ AssistantMessage, SystemMessage, UserMessage }} />
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </div>
  );
}

describe("live-input settlement labels in Chromium", () => {
  it.each([
    [1440, "desktop"],
    [390, "mobile"],
  ] as const)("renders truthful no-retry status at %ipx (%s)", (width, _label) => {
    render(<Harness width={width} />);

    const consumed = screen.getByText("Consumed by current run");
    const uncertain = screen.getByText("Delivery uncertain — not retried");
    expect(consumed).toBeVisible();
    expect(uncertain).toBeVisible();
    expect(consumed.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    expect(uncertain.getBoundingClientRect().right).toBeLessThanOrEqual(width);
  });
});
