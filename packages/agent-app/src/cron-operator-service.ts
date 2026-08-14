import { randomBytes } from "node:crypto";

import {
  MAX_CRON_JOBS,
  type CronAdapterConfig,
  type CronAdapterStartResult,
  type CronJobConfig,
} from "@mono-agent/cron-adapter";
import {
  CronOperatorError,
  type CronOperatorConfirmation,
  type CronOperatorHealth,
  type CronOperatorJob,
  type CronOperatorMutationResult,
  type CronOperatorOverview,
  type CronOperatorRun,
  type CronOperatorRunDetail,
  type CronOperatorRunPage,
  type CronOperatorRunSummary,
  type CronOperatorService,
} from "@mono-agent/operator-adapter";
import {
  MAX_CRON_OPERATOR_DEGRADED_REASON_BYTES,
  type ChannelConfigViewSection,
} from "@mono-agent/agent-contracts";

import {
  CronControlStoreError,
  cronActionRequestHash,
  type CronControlStore,
} from "./cron-control-store.js";
import type { MonoAgentAppLogger } from "./channels.js";

const CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const MAX_CONFIRMATIONS = 128;
const MAX_DEGRADED_REASON_BYTES = MAX_CRON_OPERATOR_DEGRADED_REASON_BYTES;

interface ConfirmationEntry {
  readonly token: string;
  readonly actionHash: string;
  readonly expiresAtMs: number;
  readonly confirmation: CronOperatorConfirmation;
}

export interface CronOperatorServiceInput {
  readonly config: CronAdapterConfig;
  readonly configView: () => ChannelConfigViewSection | Promise<ChannelConfigViewSection>;
  readonly store?: CronControlStore;
  readonly adapter?: CronAdapterStartResult;
  readonly effectiveEnabledByJobId?: ReadonlyMap<string, boolean>;
  readonly degradedReason?: string;
  readonly onEffectiveEnabledChanged?: () => void;
  readonly now?: () => Date;
  readonly logger?: MonoAgentAppLogger;
}

/** Build the agent-owned service shared by every operator UI (web now, TUI later). */
export function createCronOperatorService(input: CronOperatorServiceInput): CronOperatorService {
  const now = input.now ?? (() => new Date());
  const configuredById = new Map(input.config.jobs.map((job) => [job.id, job]));
  const confirmations = new Map<string, ConfirmationEntry>();
  const actionsEnabled = input.config.operatorActionsEnabled === true
    && input.store !== undefined
    && input.adapter !== undefined
    && input.degradedReason === undefined;

  const requireConfigured = (jobId: string): CronJobConfig => {
    const job = configuredById.get(jobId);
    if (job === undefined) {
      throw new CronOperatorError("not_found", `Configured cron job not found: ${jobId}`, 404);
    }
    return job;
  };
  const requireActions = (): { readonly store: CronControlStore; readonly adapter: CronAdapterStartResult } => {
    if (!actionsEnabled || input.store === undefined || input.adapter === undefined) {
      throw new CronOperatorError(
        "actions_disabled",
        input.degradedReason === undefined
          ? "Cron operator actions are disabled by configuration."
          : `Cron operator actions are unavailable while state is degraded: ${input.degradedReason}`,
        403,
      );
    }
    return { store: input.store, adapter: input.adapter };
  };
  const snapshot = (jobId: string): CronOperatorJob => {
    const configured = configuredById.get(jobId);
    const runtime = input.adapter?.snapshots().find((candidate) => candidate.jobId === jobId);
    const lastRun = input.store?.lastRun(jobId);
    return {
      jobId,
      ...(configured === undefined ? {} : { expression: configured.expression }),
      ...(configured?.timezone === undefined ? {} : { timezone: configured.timezone }),
      conversationId: configured?.conversationId ?? `cron:${jobId}`,
      configured: configured !== undefined,
      declaredEnabled: configured?.enabled === true,
      effectiveEnabled: runtime?.effectiveEnabled ?? input.effectiveEnabledByJobId?.get(jobId) ?? false,
      ...(runtime?.nextRunAt === undefined ? {} : { nextRunAt: runtime.nextRunAt }),
      health: healthOf({
        effectiveEnabled: runtime?.effectiveEnabled ?? input.effectiveEnabledByJobId?.get(jobId) ?? false,
        lastRun,
        degraded: input.degradedReason !== undefined,
      }),
      ...(lastRun === undefined ? {} : { lastRun }),
      ...(runtime?.activeRunId === undefined ? {} : { activeRunId: runtime.activeRunId }),
    };
  };
  const allJobIds = (): { readonly ids: readonly string[]; readonly truncated: boolean } => {
    const configured = [...configuredById.keys()].sort((left, right) => left.localeCompare(right));
    const configuredSet = new Set(configured);
    const historical = (input.store?.knownJobIds() ?? [])
      .filter((jobId) => !configuredSet.has(jobId))
      .sort((left, right) => left.localeCompare(right));
    const ids = [...configured, ...historical.slice(0, Math.max(0, MAX_CRON_JOBS - configured.length))];
    return { ids, truncated: configured.length + historical.length > ids.length };
  };
  const overview = (): CronOperatorOverview => {
    const jobIds = allJobIds();
    return {
      generatedAt: now().toISOString(),
      actionsEnabled,
      jobs: jobIds.ids.map(snapshot),
      ...(input.degradedReason === undefined
        ? {}
        : { degradedReason: truncateUtf8WithMarker(input.degradedReason, MAX_DEGRADED_REASON_BYTES) }),
      ...(jobIds.truncated ? { jobsTruncated: true as const } : {}),
    };
  };

  const confirmation = (
    actionHash: string,
    message: string,
    presented: string | undefined,
    audit: { readonly action: string; readonly jobId: string; readonly idempotencyKey: string },
  ): CronOperatorConfirmation | undefined => {
    pruneConfirmations(confirmations, now().getTime());
    if (presented === undefined) {
      const token = randomBytes(32).toString("base64url");
      const expiresAtMs = now().getTime() + CONFIRMATION_TTL_MS;
      const value = { token, expiresAt: new Date(expiresAtMs).toISOString(), message };
      confirmations.set(token, { token, actionHash, expiresAtMs, confirmation: value });
      while (confirmations.size > MAX_CONFIRMATIONS) {
        const oldest = confirmations.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        confirmations.delete(oldest);
      }
      input.store?.audit({ ...audit, outcome: "confirmation_required" });
      return value;
    }
    const pending = confirmations.get(presented);
    confirmations.delete(presented);
    if (pending === undefined || pending.expiresAtMs <= now().getTime() || pending.actionHash !== actionHash) {
      input.store?.audit({ ...audit, outcome: "confirmation_rejected" });
      throw new CronOperatorError(
        "confirmation_invalid",
        "The cron action confirmation is missing, expired, or belongs to another action.",
        409,
      );
    }
    return undefined;
  };

  return {
    overview,
    runs({ jobId, limit, before }) {
      const known = configuredById.has(jobId) || input.store?.knownJobIds().includes(jobId) === true;
      if (!known) throw new CronOperatorError("not_found", `Cron job not found: ${jobId}`, 404);
      if (input.store === undefined) return { runs: [] };
      try {
        return input.store.runs(jobId, limit, before);
      } catch (error) {
        throw mapStoreError(error, true);
      }
    },
    run({ jobId, runId }): CronOperatorRunDetail {
      const known = configuredById.has(jobId) || input.store?.knownJobIds().includes(jobId) === true;
      if (!known) throw new CronOperatorError("not_found", `Cron job not found: ${jobId}`, 404);
      try {
        const run = input.store?.getRun(runId);
        if (run === undefined || run.jobId !== jobId) {
          throw new CronOperatorError("not_found", `Cron run not found: ${runId}`, 404);
        }
        return run;
      } catch (error) {
        if (error instanceof CronOperatorError) throw error;
        throw mapStoreError(error);
      }
    },
    configView: input.configView,
    runNow(jobId, action): CronOperatorMutationResult<{ readonly run: CronOperatorRunSummary }> {
      requireConfigured(jobId);
      const { store, adapter } = requireActions();
      const requestHash = cronActionRequestHash({ action: "run_now", jobId });
      try {
        const replay = store.replayRunNowAction({
          jobId,
          idempotencyKey: action.idempotencyKey,
          requestHash,
        });
        if (replay !== undefined) {
          return { kind: "completed", value: { run: replay }, replayed: true };
        }
        const audit = { action: "run_now", jobId, idempotencyKey: action.idempotencyKey };
        const required = confirmation(
          requestHash,
          `Run “${jobId}” now? Cron overlap is fixed to skip: while this manual run is in flight, a scheduled firing will be recorded as skipped_overlap.`,
          action.confirmationToken,
          audit,
        );
        if (required !== undefined) return { kind: "confirmation_required", confirmation: required };
        const accepted = store.runNowAction({
          jobId,
          idempotencyKey: action.idempotencyKey,
          requestHash,
          observedAt: now().toISOString(),
        });
        if (!accepted.replayed) adapter.runNow(jobId, accepted.firing);
        const run = accepted.run ?? store.getRunSummary(accepted.firing.runId);
        if (run === undefined) throw new CronControlStoreError("corrupt", "Accepted cron run is missing.");
        input.logger?.info?.("Cron operator action completed.", {
          action: "run_now",
          jobId,
          runId: run.runId,
          idempotencyKey: action.idempotencyKey,
        });
        return { kind: "completed", value: { run }, replayed: accepted.replayed };
      } catch (error) {
        throw mapStoreError(error);
      }
    },
    setEffectiveEnabled(jobId, enabled, action): CronOperatorMutationResult<{ readonly job: CronOperatorJob }> {
      requireConfigured(jobId);
      const { store, adapter } = requireActions();
      const requestHash = cronActionRequestHash({ action: "set_enabled", jobId, enabled });
      try {
        const replay = store.replayEnabledAction({
          jobId,
          idempotencyKey: action.idempotencyKey,
          requestHash,
        });
        if (replay !== undefined) {
          return { kind: "completed", value: { job: snapshot(jobId) }, replayed: true };
        }
        const verb = enabled ? "Enable" : "Disable";
        const detail = enabled
          ? "The agent will arm the next scheduled firing."
          : "Future firings will not be armed; an active run is allowed to finish.";
        const required = confirmation(
          requestHash,
          `${verb} cron job “${jobId}”? ${detail}`,
          action.confirmationToken,
          { action: "set_enabled", jobId, idempotencyKey: action.idempotencyKey },
        );
        if (required !== undefined) return { kind: "confirmation_required", confirmation: required };
        const changed = store.setEnabledAction({
          jobId,
          enabled,
          idempotencyKey: action.idempotencyKey,
          requestHash,
        });
        adapter.setEffectiveEnabled(jobId, changed.enabled);
        input.onEffectiveEnabledChanged?.();
        input.logger?.info?.("Cron operator action completed.", {
          action: changed.enabled ? "enable" : "disable",
          jobId,
          idempotencyKey: action.idempotencyKey,
        });
        return { kind: "completed", value: { job: snapshot(jobId) }, replayed: changed.replayed };
      } catch (error) {
        throw mapStoreError(error);
      }
    },
  };
}

/** Stable indirection lets cron and TUI drivers start/reload independently. */
export class CronOperatorRegistry implements CronOperatorService {
  private service: CronOperatorService | undefined;

  get configured(): boolean {
    return this.service !== undefined;
  }

  bind(service: CronOperatorService): void {
    this.service = service;
  }

  clear(): void {
    this.service = undefined;
  }

  overview(): CronOperatorOverview | Promise<CronOperatorOverview> {
    return this.requireService().overview();
  }

  runs(input: { readonly jobId: string; readonly limit: number; readonly before?: string }): CronOperatorRunPage | Promise<CronOperatorRunPage> {
    return this.requireService().runs(input);
  }

  run(input: { readonly jobId: string; readonly runId: string }): CronOperatorRunDetail | Promise<CronOperatorRunDetail> {
    return this.requireService().run(input);
  }

  configView(): ChannelConfigViewSection | Promise<ChannelConfigViewSection> {
    return this.requireService().configView();
  }

  runNow(jobId: string, input: Parameters<CronOperatorService["runNow"]>[1]) {
    return this.requireService().runNow(jobId, input);
  }

  setEffectiveEnabled(jobId: string, enabled: boolean, input: Parameters<CronOperatorService["setEffectiveEnabled"]>[2]) {
    return this.requireService().setEffectiveEnabled(jobId, enabled, input);
  }

  private requireService(): CronOperatorService {
    if (this.service === undefined) {
      throw new CronOperatorError("unavailable", "Cron operator capability is unavailable.", 404);
    }
    return this.service;
  }
}

function healthOf(input: {
  readonly effectiveEnabled: boolean;
  readonly lastRun: CronOperatorRun | undefined;
  readonly degraded: boolean;
}): CronOperatorHealth {
  if (input.degraded) return "unknown";
  if (!input.effectiveEnabled) return "disabled";
  if (input.lastRun === undefined) return "unknown";
  if (input.lastRun.status === "failed") return "unhealthy";
  if (input.lastRun.status === "skipped_overlap" && input.lastRun.blockedByTrigger === "manual") return "healthy";
  if (["cancelled", "dropped", "skipped_overlap"].includes(input.lastRun.status)) return "warning";
  return "healthy";
}

function pruneConfirmations(confirmations: Map<string, ConfirmationEntry>, nowMs: number): void {
  for (const [token, value] of confirmations) {
    if (value.expiresAtMs <= nowMs) confirmations.delete(token);
  }
}

function mapStoreError(error: unknown, cursor = false): Error {
  if (!(error instanceof CronControlStoreError)) return error instanceof Error ? error : new Error(String(error));
  if (error.kind === "idempotency_conflict") {
    return new CronOperatorError("idempotency_conflict", error.message, 409);
  }
  if (error.kind === "replay_expired") {
    return new CronOperatorError("replay_expired", error.message, 410);
  }
  if (cursor && error.message.includes("cursor")) {
    return new CronOperatorError("invalid_request", error.message, 400);
  }
  return new CronOperatorError("unavailable", error.message, 503);
}

function truncateUtf8WithMarker(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "… [truncated]";
  const contentBytes = maxBytes - Buffer.byteLength(marker, "utf8");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= contentBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
  return `${value.slice(0, end)}${marker}`;
}
