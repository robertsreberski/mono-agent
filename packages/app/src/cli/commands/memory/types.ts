import type { MonoAgentConfig } from "@mono-agent/config";
import type { BujoMemoryHealthReport } from "@mono-agent/memory/bujo";
export const INTAKE_REASON_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
export const MEMORY_HEALTH_SCHEMA_VERSION = 1;
export const EMPTY_HEALTH_COUNTS = Object.freeze({
  pending: 0,
  due: 0,
  dead: 0,
  outbox: 0,
  temporary: 0,
  memories: 0,
  vectors: 0,
  missingVectors: 0,
});

export interface RunMemoryCommandInput {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly configPath?: string;
  readonly positionals: readonly string[];
  readonly json: boolean;
  readonly strict: boolean;
  readonly labelKind?: "fact" | "preference" | "lesson";
  readonly labelAbout?: string;
  readonly labelScope?: string;
  readonly propose?: boolean;
  readonly limit?: number;
  readonly idsFile?: string;
  readonly reason?: string;
  readonly curateSelect?: string;
  readonly curateAccept?: string;
  readonly curateReject?: string;
  /** Operator entity merges (`fromId=toId`) for curate prepare/review. */
  readonly curateMerges?: readonly string[];
  readonly curateMergeFile?: string;
  readonly allowCrossType?: boolean;
  /** `memory curate prepare --owner-backfill`. */
  readonly ownerBackfill?: boolean;
  /** `memory curate prepare --limit 0 --link-people`. */
  readonly linkPeople?: boolean;
  /** `memory curate prepare --tasks-to-notes [--before <date>] [--capture-only]`. */
  readonly tasksToNotes?: boolean;
  /** Explicit reviewed note/event and label pass before semantic-only enablement. */
  readonly semanticReview?: boolean;
  readonly tasksBefore?: string;
  readonly captureOnly?: boolean;
  /** `memory entities --duplicates`. */
  readonly duplicates?: boolean;
  readonly model?: string;
  readonly dryRun?: boolean;
  /** Host-injected fake memory model for isolated curation preparation tests. */
  readonly curateLlm?: import("@mono-agent/memory/bujo").LlmComplete;
  readonly planPath?: string;
  readonly backupPath?: string;
  readonly bundlePath?: string;
  readonly includeExtras?: boolean;
  readonly allowPending?: boolean;
  readonly onConflict?: "fail" | "skip";
  readonly entityConflict?: "target" | "source";
  readonly acceptDerivedAssociationDrift?: boolean;
}

export interface MemoryCommandContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly configPath: string;
  readonly config: MonoAgentConfig;
}

export interface PreviewRecallHit {
  readonly score: number;
  readonly record: {
    readonly id: string;
    readonly text: string;
    readonly source?: { readonly file?: string; readonly line?: number; readonly session?: string };
    readonly salience?: number;
    readonly createdAt?: string;
  };
}

export type PublishedMemoryHealthStatus = BujoMemoryHealthReport["status"] | "not_configured";
export type StrictMemoryHealthReport =
  | BujoMemoryHealthReport
  | {
      readonly schemaVersion: typeof MEMORY_HEALTH_SCHEMA_VERSION;
      readonly backend: "bujo";
      readonly mode: NonNullable<MonoAgentConfig["memory"]>["mode"];
      readonly status: "unknown";
      readonly checkedAt: string;
      readonly issues: readonly ("native_module_unavailable" | "health_check_failed")[];
      readonly counts: typeof EMPTY_HEALTH_COUNTS;
    }
  | {
      readonly schemaVersion: typeof MEMORY_HEALTH_SCHEMA_VERSION;
      readonly backend: "none";
      readonly status: "not_configured";
      readonly checkedAt: string;
      readonly issues: readonly [];
      readonly counts: typeof EMPTY_HEALTH_COUNTS;
    };
