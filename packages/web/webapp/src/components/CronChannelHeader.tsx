import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import { api } from "../api";
import { useConsoleStore } from "../console-store";
import type {
  ChannelConfigView,
  CronConfirmation,
  CronJob,
  CronMutationResult,
  CronRun,
} from "../types";
import { Icon } from "./Icon";

type CronAction =
  | { readonly kind: "run"; readonly idempotencyKey: string }
  | { readonly kind: "enabled"; readonly enabled: boolean; readonly idempotencyKey: string };

interface PendingConfirmation {
  readonly action: CronAction;
  readonly confirmation: CronConfirmation;
}

const actionKey = (): string => globalThis.crypto.randomUUID();

const displayTime = (value: string | undefined): string => {
  if (value === undefined) return "Unknown";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
};

export const cronRunAnchor = (runId: string): string =>
  `cron-run-${encodeURIComponent(runId)}`;

function CronDialog({
  label,
  children,
  onClose,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      prior?.focus();
    };
  }, [onClose]);
  return (
    <div className="dialog-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="cron-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </section>
    </div>
  );
}

const resultNotice = (message: string): void => {
  window.dispatchEvent(new CustomEvent("mono-agent:notice", { detail: { message } }));
};

export function CronChannelHeader() {
  const {
    selectedAgent,
    selectedThread,
    cronOverview,
    cronLoading,
    cronError,
    connection,
    refreshCron,
  } = useConsoleStore();
  const jobId = selectedThread?.trigger?.kind === "cron"
    ? selectedThread.trigger.jobId
    : undefined;
  const job = useMemo(
    () => cronOverview?.jobs.find((candidate) => candidate.jobId === jobId),
    [cronOverview?.jobs, jobId],
  );
  const [pending, setPending] = useState<PendingConfirmation>();
  const [configView, setConfigView] = useState<ChannelConfigView>();
  const [configOpen, setConfigOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const actionUnavailableId = useId();
  const configUnavailableId = useId();

  useEffect(() => {
    setPending(undefined);
    setConfigOpen(false);
    setError(undefined);
  }, [jobId, selectedAgent?.sourceId]);

  if (selectedThread?.trigger?.kind !== "cron") return null;

  const sourceId = selectedAgent?.sourceId;
  const online = connection === "live" && selectedAgent?.status !== "offline";
  const actionsAvailable = sourceId !== undefined
    && job !== undefined
    && job.configured
    && online
    && selectedAgent?.cron?.actions === true
    && cronOverview?.actionsEnabled === true;
  const configAvailable = sourceId !== undefined
    && online
    && selectedAgent?.cron?.read === true;
  const offline = connection !== "live" || selectedAgent?.status === "offline";
  const actionUnavailableReason = cronOverview?.degradedReason
    ?? (sourceId === undefined
      ? "Cron controls are unavailable because no agent is selected."
      : offline
        ? "Cron controls are unavailable while the agent is offline."
        : job === undefined
          ? "Cron controls are unavailable while the authoritative job state is loading."
          : !job.configured
            ? "Cron controls are unavailable for a historical job that is no longer configured."
            : cronOverview?.actionsEnabled !== true
              ? "Cron operator actions are disabled by agent configuration."
              : selectedAgent?.cron?.actions !== true
                ? "Cron operator actions require an operator API key, which is not configured."
                : undefined);
  const configUnavailableReason = sourceId === undefined
    ? "Cron configuration is unavailable because no agent is selected."
    : offline
      ? "Cron configuration is unavailable while the agent is offline."
      : selectedAgent?.cron?.read !== true
        ? "Cron configuration is unavailable because this agent does not expose cron operator reads."
        : undefined;

  const callAction = async (
    action: CronAction,
    confirmationToken?: string,
  ): Promise<CronMutationResult<{ readonly run: CronRun } | { readonly job: CronJob }>> => {
    if (sourceId === undefined || jobId === undefined) throw new Error("Cron job identity is unavailable.");
    if (action.kind === "run") {
      return await api.cronRunNow(sourceId, jobId, action.idempotencyKey, confirmationToken);
    }
    return await api.cronSetEnabled(
      sourceId,
      jobId,
      action.enabled,
      action.idempotencyKey,
      confirmationToken,
    );
  };

  const begin = async (action: CronAction): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await callAction(action);
      if (result.kind === "confirmation_required") {
        setPending({ action, confirmation: result.confirmation });
        return;
      }
      await refreshCron();
      resultNotice(result.replayed ? "Cron action was already applied." : "Cron action applied.");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Cron action failed.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (pending === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await callAction(pending.action, pending.confirmation.token);
      if (result.kind === "confirmation_required") {
        setPending({ action: pending.action, confirmation: result.confirmation });
        return;
      }
      setPending(undefined);
      await refreshCron();
      resultNotice(result.replayed ? "Cron action was already applied." : "Cron action applied.");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Cron action failed.");
    } finally {
      setBusy(false);
    }
  };

  const openConfig = async (): Promise<void> => {
    if (sourceId === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      setConfigView(await api.cronConfigView(sourceId));
      setConfigOpen(true);
    } catch (configError) {
      setError(configError instanceof Error ? configError.message : "Cron configuration is unavailable.");
    } finally {
      setBusy(false);
    }
  };

  const stateLabel = job === undefined
    ? "Unknown"
    : job.effectiveEnabled
      ? "Enabled"
      : "Disabled";
  const declaredDifference = job !== undefined && job.declaredEnabled !== job.effectiveEnabled;

  return (
    <>
      <section className="cron-channel-header" aria-label="Cron job status">
        <dl className="cron-channel-facts">
          <div><dt>Schedule</dt><dd><code>{job?.expression ?? "Unknown"}</code></dd></div>
          <div><dt>Timezone</dt><dd>{job?.timezone ?? "Unknown"}</dd></div>
          <div>
            <dt>State</dt>
            <dd>
              {stateLabel}
              {declaredDifference && (
                <small>Config {job.declaredEnabled ? "enabled" : "disabled"}; runtime override {job.effectiveEnabled ? "enabled" : "disabled"}</small>
              )}
            </dd>
          </div>
          <div>
            <dt>Last run</dt>
            <dd title={job?.lastRun?.orderedAt}>
              {job?.lastRun === undefined ? "Unknown" : (
                <a href={`#${cronRunAnchor(job.lastRun.runId)}`}>{displayTime(job.lastRun.orderedAt)}</a>
              )}
            </dd>
          </div>
          <div><dt>Next run</dt><dd title={job?.nextRunAt}>{displayTime(job?.nextRunAt)}</dd></div>
          <div>
            <dt>Health</dt>
            <dd className={`cron-health is-${job?.health ?? "unknown"}`}>
              {job?.health ?? "unknown"}
              {cronOverview?.degradedReason !== undefined && <small>{cronOverview.degradedReason}</small>}
            </dd>
          </div>
        </dl>
        <div className="cron-channel-actions" aria-label="Cron controls">
          <button
            type="button"
            className="cron-action-primary"
            disabled={!actionsAvailable || busy}
            aria-describedby={actionUnavailableReason === undefined ? undefined : actionUnavailableId}
            onClick={() => void begin({ kind: "run", idempotencyKey: actionKey() })}
          >
            <Icon name="spark" size={14} />
            Run now
          </button>
          <button
            type="button"
            disabled={!actionsAvailable || busy}
            aria-describedby={actionUnavailableReason === undefined ? undefined : actionUnavailableId}
            onClick={() => void begin({
              kind: "enabled",
              enabled: !(job?.effectiveEnabled ?? false),
              idempotencyKey: actionKey(),
            })}
          >
            {job?.effectiveEnabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            disabled={!configAvailable || busy}
            aria-describedby={configUnavailableReason === undefined ? undefined : configUnavailableId}
            onClick={() => void openConfig()}
          >
            Configuration
          </button>
          {job !== undefined && (
            <span className="cron-session-link" title={job.conversationId}>
              Session <code>{job.conversationId}</code>
            </span>
          )}
        </div>
        {actionUnavailableReason !== undefined && (
          <p id={actionUnavailableId} className="cron-unavailable-reason" role="status" tabIndex={0}>
            {actionUnavailableReason}
          </p>
        )}
        {configUnavailableReason !== undefined && (
          <p id={configUnavailableId} className="cron-unavailable-reason" role="status" tabIndex={0}>
            {configUnavailableReason}
          </p>
        )}
        {cronOverview?.jobsTruncated === true && (
          <p className="cron-unavailable-reason" role="status">
            Older historical jobs are omitted from this bounded overview; their saved conversations remain available.
          </p>
        )}
        {cronLoading && <span className="cron-refreshing" role="status">Refreshing cron state…</span>}
        {cronError != null && <p className="cron-action-error" role="alert">{cronError}</p>}
        {error !== undefined && <p className="cron-action-error" role="alert">{error}</p>}
      </section>

      {pending !== undefined && (
        <CronDialog label="Confirm cron action" onClose={() => !busy && setPending(undefined)}>
          <header>
            <div><span className="eyebrow">Confirmation required</span><h2>Confirm cron action</h2></div>
            <button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={() => setPending(undefined)}>
              <Icon name="close" size={17} />
            </button>
          </header>
          <p>{pending.confirmation.message}</p>
          <small>Confirmation expires {displayTime(pending.confirmation.expiresAt)}.</small>
          {error !== undefined && <p className="cron-action-error" role="alert">{error}</p>}
          <footer>
            <button type="button" disabled={busy} onClick={() => setPending(undefined)}>Cancel</button>
            <button type="button" className="cron-action-primary" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Applying…" : "Confirm"}
            </button>
          </footer>
        </CronDialog>
      )}

      {configOpen && configView !== undefined && (
        <CronDialog label="Cron configuration" onClose={() => setConfigOpen(false)}>
          <header>
            <div><span className="eyebrow">Redacted agent view</span><h2>{configView.label}</h2></div>
            <button type="button" className="icon-button" aria-label="Close" onClick={() => setConfigOpen(false)}>
              <Icon name="close" size={17} />
            </button>
          </header>
          <dl className="cron-config-fields">
            {configView.fields.map((field) => (
              <div key={field.id}>
                <dt>{field.label}</dt>
                <dd><code>{field.value}</code></dd>
                <small>{field.source}{field.redacted === true ? " · redacted" : ""}</small>
              </div>
            ))}
          </dl>
          <footer><button type="button" onClick={() => setConfigOpen(false)}>Close</button></footer>
        </CronDialog>
      )}
    </>
  );
}
