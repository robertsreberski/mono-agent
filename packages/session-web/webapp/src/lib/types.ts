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
}

// SSE stream envelope (each `data:` line is one of these).
export type StreamMessage =
  | { t: "instances"; instances: WebInstance[] }
  | { t: "session_upsert"; session: Session }
  | { t: "session_removed"; sourceId: string; runId: string };

export type Channel = "cron" | "webhook" | "chat" | "memory" | string;
