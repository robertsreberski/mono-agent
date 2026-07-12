// Data model — mirrors the backend (@mono-agent/session-web) contract exactly.

export type Outcome = "silent" | "notified";

export interface Totals {
  asst: number;
  tcalls: number;
  think: number;
  tokIn: number;
  tokOut: number;
  tokCache: number;
  cost: number;
  steps: number;
}

export interface ToolCall {
  id: string;
  name: string;
  dig: string;
  raw: string;
  tr?: boolean;
  ok?: boolean;
  durMs?: number;
  fileChange?: ToolFileChange;
}

export interface ToolFileChange {
  status: string;
  files: number;
  addedLines?: number;
  removedLines?: number;
  changedLines?: number;
  unavailableCount?: number;
  changes: {
    path?: string;
    kind?: string;
    lineStats?: {
      beforeLines?: number;
      afterLines?: number;
      addedLines?: number;
      removedLines?: number;
      changedLines?: number;
      unavailableReason?: string;
    };
  }[];
}

export interface Usage {
  i: number;
  o: number;
  c: number;
  cost: number;
}

export interface FailoverAttempt {
  model?: string;
  failureKind?: string;
  subkind?: string;
  requestId?: string;
}

/** One prior conversation message the turn was driven with. Mirrors observability's `SessionCtxMsg`. */
export interface CtxMsg {
  role: string;
  text: string;
  name?: string;
  ts?: string;
  /** Set when `text` was capped for display. */
  tr?: boolean;
}

/** The context a single turn was driven with (history + recalled memory). Mirrors observability's `SessionTurnContext`. */
export interface TurnContext {
  histCount: number;
  /** Present only when true: the provider session carried the transcript (warm in-process session, or durable cross-restart resume with no locally loaded history). */
  histOmitted?: boolean;
  hist?: CtxMsg[];
  mem?: { text: string; src?: string; tr?: boolean };
}

export type SessionStep =
  | { k: "prompt"; ts: string; text: string; tr?: boolean; chars?: number }
  | {
      k: "assistant";
      ts: string;
      think: { t: string; tr?: boolean }[];
      calls: ToolCall[];
      text: string;
      ttr?: boolean;
      model?: string;
      stop?: string;
      u?: Usage;
    }
  | {
      k: "boundary";
      ts: string;
      kind: string;
      conversationId?: string;
      baseConversationId?: string;
      previousConversationId?: string;
      providerSessionId?: string;
      reason?: string;
    }
  | {
      k: "runtime";
      ts: string;
      type: "runtime_warning";
      severity: "warning";
      message: string;
      kind?: string;
    }
  | {
      k: "runtime";
      ts: string;
      type: "provider_status";
      kind: string;
      model?: string;
      from?: string;
      to?: string;
      attemptIndex?: number;
      durationMs?: number;
      cancelled?: boolean;
    }
  | {
      k: "runtime";
      ts: string;
      type: "runtime_telemetry";
      kind: string;
    }
  | {
      k: "runtime";
      ts: string;
      type: "file_change";
      kind: "file_change";
      status: string;
      ok: boolean;
      paths: string[];
      files: number;
      addedLines?: number;
      removedLines?: number;
      changedLines?: number;
      unavailableCount?: number;
      error?: string;
    }
  | {
      k: "result";
      ts: string;
      tcid: string;
      tool: string;
      ok: boolean;
      dig: string;
      text: string;
      tr?: boolean;
      chars?: number;
    };

export interface Session {
  id: string;
  conversationId?: string;
  cwd: string;
  instance: string;
  startTs: string;
  durMs: number;
  kind?: string;
  trigger?: string;
  source: string;
  title: string;
  outcome: Outcome;
  model?: string;
  provider?: string;
  providerSessionId?: string | null;
  isolated?: boolean;
  api?: string;
  effort?: string;
  instr: string;
  instrTr?: boolean;
  recalled?: string;
  recalledTr?: boolean;
  hasRecall: boolean;
  /** The context this turn was driven with (history + recalled memory), when recorded. */
  ctx?: TurnContext;
  /** The compiled system prompt the run was driven with (redacted + capped). */
  sysPrompt?: string;
  /** Set when `sysPrompt` was capped for display. */
  sysPromptTr?: boolean;
  finalText: string;
  finalTr?: boolean;
  status: string;
  failureKind?: string;
  error?: string;
  failoverHistory?: FailoverAttempt[];
  totals: Totals;
  toolCounts: Record<string, number>;
  steps: SessionStep[];
  /** Optional — some backends stamp the owning trace-source id on the session. */
  sourceId?: string;
}

export interface WebInstance {
  sourceId: string;
  label: string;
  cwd: string;
  artifactDir: string;
  health: string;
  liveConnected: boolean;
  counts: { runs: number };
  timeZone?: string;
  memoryHealth?: TraceSourceMemoryHealth;
}

export type TraceSourceMemoryBackend = "bujo" | "supermemory" | "none";
export type TraceSourceMemoryMode = "lite" | "journal" | "bujo";
export type TraceSourceMemoryStatus =
  | "healthy"
  | "in_progress"
  | "degraded"
  | "unhealthy"
  | "unknown"
  | "not_configured";
export type TraceSourceMemoryIssue =
  | "manifest_missing"
  | "manifest_invalid"
  | "configured_identity_mismatch"
  | "database_missing"
  | "database_unavailable"
  | "native_module_unavailable"
  | "sqlite_integrity_failed"
  | "metadata_mismatch"
  | "fts_mismatch"
  | "vector_mismatch"
  | "orphaned_rows"
  | "canonical_mismatch"
  | "canonical_invalid"
  | "mutation_in_progress"
  | "intake_invalid"
  | "intake_pending"
  | "dead_letters"
  | "outbox_invalid"
  | "outbox_pending"
  | "temporary_artifacts"
  | "runtime_missing"
  | "runtime_stale"
  | "runtime_invalid";

export interface TraceSourceMemoryHealth {
  backend: TraceSourceMemoryBackend;
  mode?: TraceSourceMemoryMode;
  status: TraceSourceMemoryStatus;
  checkedAt: string;
  issues?: TraceSourceMemoryIssue[];
  counts?: {
    pending?: number;
    due?: number;
    dead?: number;
    outbox?: number;
    temporary?: number;
    memories?: number;
    vectors?: number;
    missingVectors?: number;
  };
}

// SSE stream envelope (each `data:` line is one of these).
export type StreamMessage =
  | { t: "instances"; instances: WebInstance[] }
  | { t: "session_upsert"; session: Session }
  | { t: "session_removed"; sourceId: string; runId: string };

export type Channel = "cron" | "webhook" | "chat" | "memory" | string;
