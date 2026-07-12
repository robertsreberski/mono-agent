/**
 * The web operator surface's data model. The heavy lifting — turning a recorded
 * run into a renderable {@link Session} — lives in `@mono-agent/observability`
 * (`mapRunToSession`); this module re-exports those frozen types verbatim (never
 * redefines them) and adds the two shapes unique to the browser boundary: the
 * per-instance summary the discovery layer produces ({@link WebInstance}) and the
 * SSE frame union the aggregator fans out to the browser ({@link BrowserStreamFrame}).
 */

export type {
  Session,
  SessionOutcome,
  SessionStep,
  SessionStepUsage,
  SessionThink,
  SessionToolCall,
  SessionTotals,
} from "@mono-agent/observability";

import type { Session, TraceSourceMemoryHealth } from "@mono-agent/observability";

/**
 * One discovered agent instance, projected for the browser. `sourceId` is the
 * trace-source registry id; `liveConnected` reflects whether the aggregator
 * currently holds an open SSE connection to this instance's `live` endpoint (so
 * sub-run streaming is active); `counts.runs` is how many sessions the aggregator
 * currently holds for it (seeded history + any live/artifact upserts).
 */
export interface WebInstance {
  readonly sourceId: string;
  readonly label: string;
  /** Working directory the instance runs in — `dirname(configPath)` when known, else the artifact dir's parent. */
  readonly cwd: string;
  readonly artifactDir: string;
  /** Trace-source health: "running" | "stale" | "failed" (never "stopped" — those are filtered out). */
  readonly health: string;
  /** Best-effort instance timezone from trace metadata or runtime.session.rolloverTimezone. */
  readonly timeZone?: string;
  /** Back-compat spelling for clients that already probe `timezone`. */
  readonly timezone?: string;
  /** Content-free, registry-normalized memory health; no arbitrary manifest metadata crosses this boundary. */
  readonly memoryHealth?: TraceSourceMemoryHealth;
  readonly liveConnected: boolean;
  readonly counts: { readonly runs: number };
}

/**
 * A frame on the browser SSE stream (`GET /api/stream`). `instances` replaces the
 * client's instance list wholesale; `session_upsert` inserts-or-replaces one
 * session by `session.sourceId + session.id` (both the recorded-artifact path and
 * the live-fold path emit these — last write wins within one source);
 * `session_removed` drops one run from one source (e.g. its instance vanished
 * from the registry).
 */
export type BrowserStreamFrame =
  | { readonly t: "instances"; readonly instances: readonly WebInstance[] }
  | { readonly t: "session_upsert"; readonly session: Session }
  | { readonly t: "session_removed"; readonly sourceId: string; readonly runId: string };
