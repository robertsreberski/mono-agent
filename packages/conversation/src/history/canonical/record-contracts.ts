import type { HistoryMessage } from "../../context/index.js";
import type { NativeTurnHistory } from "../model-switch/contract.js";
import type { DurableTurnReceipt, PendingTurnPointer } from "../pending-turn/contract.js";
import type { TurnHistoryV3 } from "../pending-turn/canonical-record.js";

export const LEGACY_STORE_VERSION = 1;
export const PROVIDER_STORE_VERSION = 2;
export const STORE_VERSION = 3;
export const DEFAULT_MAX_MESSAGES = 64;
export const MAX_MESSAGE_CONTENT_BYTES = 64 * 1024;
export const MAX_MESSAGE_ENVELOPE_BYTES = 16 * 1024;
// JSON may encode one content byte as a six-byte escape (for example, NUL).
export const MAX_MESSAGE_SERIALIZED_BYTES = MAX_MESSAGE_CONTENT_BYTES * 6 + MAX_MESSAGE_ENVELOPE_BYTES;
export const MAX_STORE_FILE_BYTES = DEFAULT_MAX_MESSAGES * MAX_MESSAGE_SERIALIZED_BYTES + 64 * 1024;
export const MAX_DIRTY_FENCE_BYTES = 1024;
export const MAX_RUN_ID_BYTES = 4 * 1024;

interface ProviderSessionState {
  readonly modelKey?: string;
  readonly epoch: string;
  readonly revision?: number;
  readonly dirtyRunId?: string;
}

export type CanonicalHistoryFile = TurnHistoryV3 | NativeTurnHistory;

export interface LoadedHistoryRecord {
  readonly lastCommit?: DurableTurnReceipt;
  readonly sourceVersion: 0 | typeof LEGACY_STORE_VERSION | typeof PROVIDER_STORE_VERSION | typeof STORE_VERSION;
  readonly native?: NativeTurnHistory["native"];
  readonly lastSwitch?: NonNullable<NativeTurnHistory["lastSwitch"]>;
  readonly conversationId: string;
  readonly messages: readonly HistoryMessage[];
  readonly providerSession?: ProviderSessionState;
}

export interface DirtyFence {
  readonly kind?: "execution" | "compaction" | "retirement";
  readonly payload?: PendingTurnPointer;
  readonly modelKey?: string;
  readonly path: string;
  readonly conversationKey: string;
  readonly logicalConversationKey?: string;
  readonly epoch: string;
  readonly providerSessionId?: string;
  readonly revision: number;
  readonly runIdDigest: string;
  readonly mtimeMs?: number;
}

export const DIRTY_FENCE_PATTERN = /^([a-f0-9]{64})\.dirty\.json$/u;
export const DIRTY_FENCE_TEMP_PATTERN = /^\.([a-f0-9]{64})\.([0-9]+)\.([a-f0-9]{24})\.dirty\.tmp$/u;
