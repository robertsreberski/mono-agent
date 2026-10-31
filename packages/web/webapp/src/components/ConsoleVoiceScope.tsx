import { unstable_useComposerInput, useAuiState } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { useConsoleStore } from "../console-store";
import { runningManualCompaction } from "../manual-compaction";
import { VoiceComposerScope } from "./VoiceComposer";

/** Stable across the viewport/composer's intentional per-conversation remounts. */
export function ConsoleVoiceScope({ children }: { readonly children: ReactNode }) {
  const store = useConsoleStore();
  const composer = unstable_useComposerInput();
  const hasQuote = useAuiState((state) => Boolean(state.composer.quote));
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  const runtimeThreadId = useAuiState((state) => state.threadListItem?.remoteId ?? null);
  const { selectedAgent, selectedThread } = store;
  const unavailableReason = !store.bootstrap?.voice?.enabled ? "Voice messages are not configured on this console."
    : store.selectionLoading || store.selectionError !== null || runtimeThreadId !== store.selectedThreadId
      || !selectedAgent || selectedAgent.status === "offline" || selectedThread?.archivedAt
      || selectedThread?.trigger?.kind === "cron" || (selectedThread && !selectedThread.canSend)
      || runningManualCompaction(selectedThread)
      ? "Select a connected, writable conversation and wait for compaction to finish."
      : composer.value.length > 0 || attachmentCount > 0 || hasQuote
        ? "Send or clear text, files and quotes before recording a voice message." : undefined;
  return <VoiceComposerScope visible={store.conversationVisible} selectionGeneration={store.selectionGeneration}
    captureSubmission={store.captureVoiceSubmission} unavailableReason={unavailableReason}>
    {children}
  </VoiceComposerScope>;
}
