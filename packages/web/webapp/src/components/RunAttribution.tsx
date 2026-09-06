import type { RunAttribution as RunAttributionValue, RunStatus } from "../types";

const effortLabel = (effort: string | undefined): string | undefined => {
  if (effort === undefined) return undefined;
  return effort.length === 0 ? undefined : `${effort[0]!.toUpperCase()}${effort.slice(1)}`;
};

const routeLabel = (model: string | undefined, effort: string | undefined): string => {
  const effortText = effortLabel(effort);
  if (model === undefined) return effortText === undefined ? "route not reported" : effortText;
  return effortText === undefined ? model : `${model} · ${effortText}`;
};

export function runAttributionSummary(
  attribution: RunAttributionValue,
  status: RunStatus | WebMessageStatus,
): string {
  const target = attribution.executed ?? attribution.attempted ?? attribution.requested;
  if (attribution.disposition === "fallback") {
    const from = attribution.requested.model ?? attribution.transitions[0]?.from ?? "requested route";
    const to = target.model ?? attribution.transitions.at(-1)?.to ?? "fallback route";
    const reason = attribution.transitions.at(-1)?.reason ?? "reason not reported";
    return `Fallback: ${from} → ${to} · ${reason}`;
  }
  const verb = status === "running" ? "Running with" : status === "complete" ? "Ran with" : "Tried";
  return `${verb} ${routeLabel(target.model, target.effort)}`;
}

const headerAttributionSummary = (
  attribution: RunAttributionValue,
  status: RunStatus | WebMessageStatus,
): string => {
  const target = attribution.executed ?? attribution.attempted ?? attribution.requested;
  if (attribution.disposition === "fallback") {
    const from = attribution.requested.model ?? attribution.transitions[0]?.from ?? "requested route";
    const to = target.model ?? attribution.transitions.at(-1)?.to ?? "fallback route";
    return `${from} → ${to}`;
  }
  return `${status === "running" ? "Running" : "Last run"} · ${routeLabel(target.model, target.effort)}`;
};

type WebMessageStatus = "running" | "complete" | "failed" | "cancelled" | "interrupted";

export function RunAttribution({
  attribution,
  status,
  compact = false,
}: {
  readonly attribution?: RunAttributionValue;
  readonly status: RunStatus | WebMessageStatus;
  readonly compact?: boolean;
}) {
  if (attribution === undefined) return null;
  const fallback = attribution.disposition === "fallback";
  const effectiveEffort = effortLabel((attribution.executed ?? attribution.attempted)?.effectiveEffort);
  const requestedEffort = effortLabel(attribution.requested.effort);
  const effortChanged = effectiveEffort !== undefined
    && (requestedEffort === undefined || effectiveEffort.toLowerCase() !== requestedEffort.toLowerCase());
  const hasDetails = attribution.transitions.length > 0
    || attribution.retries.length > 0
    || attribution.truncated === true
    || effectiveEffort !== undefined;

  return (
    <div
      className={`run-attribution${compact ? " is-compact" : ""}${fallback ? " is-fallback" : ""}`}
      data-run-attribution={attribution.disposition}
      {...(fallback ? { role: "status", "aria-label": "Model fallback" } : {})}
    >
      <div className="run-attribution-summary">
        {fallback && <strong className="run-attribution-warning">Fallback</strong>}
        <span>{compact ? headerAttributionSummary(attribution, status) : runAttributionSummary(attribution, status)}</span>
        {!compact && effortChanged && (
          <span className="run-attribution-effort">
            {requestedEffort === undefined ? `Effective ${effectiveEffort}` : `Requested ${requestedEffort} → effective ${effectiveEffort}`}
          </span>
        )}
      </div>
      {!compact && hasDetails && (
        <details className="run-attribution-details">
          <summary>Routing details</summary>
          <dl>
            <div><dt>Requested</dt><dd>{routeLabel(attribution.requested.model, attribution.requested.effort)}</dd></div>
            {attribution.attempted && <div><dt>Attempted</dt><dd>{routeLabel(attribution.attempted.model, attribution.attempted.effort)}</dd></div>}
            {attribution.executed && <div><dt>Executed</dt><dd>{routeLabel(attribution.executed.model, attribution.executed.effort)}</dd></div>}
            {effectiveEffort && <div><dt>Effective effort</dt><dd>{effectiveEffort}</dd></div>}
          </dl>
          {attribution.transitions.length > 0 && (
            <ol aria-label="Fallback transitions">
              {attribution.transitions.map((transition, index) => (
                <li key={`${transition.from}:${transition.to}:${String(index)}`}>
                  {transition.from} → {transition.to} · {transition.reason ?? "reason not reported"}
                </li>
              ))}
            </ol>
          )}
          {attribution.retries.length > 0 && (
            <ol aria-label="Provider retries">
              {attribution.retries.map((retry, index) => (
                <li key={`${retry.model ?? "route"}:${String(index)}`}>
                  Retried {retry.model ?? "current route"}
                  {retry.retryIndex === undefined ? "" : ` · attempt ${String(retry.retryIndex + 1)}`}
                  {retry.reason === undefined ? "" : ` · ${retry.reason}`}
                </li>
              ))}
            </ol>
          )}
          {attribution.truncated === true && <p>Older routing entries were omitted.</p>}
        </details>
      )}
    </div>
  );
}
