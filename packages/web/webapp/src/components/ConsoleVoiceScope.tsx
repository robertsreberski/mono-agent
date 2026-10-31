import type { ReactNode } from "react";
import { useConsoleStore } from "../console-store";
import { canUploadInConsole } from "../capabilities";
import { runningManualCompaction } from "../manual-compaction";
import { VoiceComposerScope } from "./VoiceComposer";

/** Stable capture owner, independent of the keyed composer and ordinary Send. */
export function ConsoleVoiceScope({ children }: { readonly children: ReactNode }) {
  const store = useConsoleStore();
  const reason = !store.bootstrap?.voice?.enabled ? "Audio transcription is not configured on this console."
    : store.selectionLoading || store.selectionError !== null || !canUploadInConsole(store.connection, store.selectedAgent, store.selectedThread)
      || store.selectedThread?.archivedAt || store.selectedThread?.trigger?.kind === "cron" || runningManualCompaction(store.selectedThread)
      ? "Select a connected conversation with attachment support and wait for compaction to finish." : undefined;
  return <VoiceComposerScope unavailableReason={reason}>{children}</VoiceComposerScope>;
}
