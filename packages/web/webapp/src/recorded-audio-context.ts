import { createContext, useContext } from "react";
import type { WebUploadAttachmentAdapter } from "./attachment-adapter";
export interface RecordedAudioState {
  readonly adapter: WebUploadAttachmentAdapter;
  readonly busy: boolean;
  readonly error?: string;
  readonly uncertain: boolean;
  readonly pending?: boolean;
  readonly text?: string;
  readonly files?: readonly { id: string; file: File; recorded: boolean }[];
  readonly remove?: () => void;
  readonly retry: () => void;
}
export const RecordedAudioContext = createContext<RecordedAudioState | null>(null);
export const useRecordedAudio = () => useContext(RecordedAudioContext);
