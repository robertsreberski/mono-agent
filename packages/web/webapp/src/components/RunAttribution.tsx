import type { RunAttribution as RunAttributionValue, RunStatus } from "../types";
import { sameModel } from "./model-comparison";

const effortLabel = (effort: string | undefined): string | undefined => {
  if (effort === undefined) return undefined;
  return effort.length === 0 ? undefined : `${effort[0]!.toUpperCase()}${effort.slice(1)}`;
};

/**
 * Normalize effort values for comparison. Providers report the "off" thinking
 * level as either "off" or "none"; route-label.ts presents "none" as "off",
 * so the attribution footer should treat them as equivalent.
 */
const canonicalEffort = (effort: string): string => {
  const lower = effort.toLowerCase();
  return lower === "none" ? "off" : lower;
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

type WebMessageStatus = "running" | "complete" | "failed" | "cancelled" | "interrupted";

/**
 * Only a run that DEVIATED from what was asked keeps this footer: a fallback,
 * a recorded transition or retry, an effort the provider did not honour, or an
 * unsettled run already attempting another model than the requested one.
 *
 * Running on a different model than the one the conversation is set to right
 * now is not a deviation — the operator switched the route afterwards, and the
 * transcript rules that switch where it happened (see {@link ModelMarkers}). So
 * the currently selected model deliberately has no say here; an ordinary turn
 * carries no footer however often the selection moves under it.
 *
 * The unsettled arm exists because the server settles `fallback` only when a
 * run completes: while a turn is running, failed or cancelled, a route that
 * already left the requested one is visible on the attempt alone.
 */
export function shouldShowMessageRunAttribution(
  attribution: RunAttributionValue | undefined,
  status: RunStatus | WebMessageStatus,
): boolean {
  if (attribution === undefined) return false;
  if (attribution.disposition === "fallback") return true;
  if (attribution.transitions.length > 0 || attribution.retries.length > 0) return true;
  const run = attribution.executed ?? attribution.attempted;
  const requestedEffort = attribution.requested.effort;
  if (
    run?.effectiveEffort !== undefined
    && requestedEffort !== undefined
    && canonicalEffort(run.effectiveEffort) !== canonicalEffort(requestedEffort)
  ) {
    return true;
  }
  const attemptedModel = run?.model;
  const requestedModel = attribution.requested.model;
  return status !== "complete"
    && attemptedModel !== undefined
    && attemptedModel.length > 0
    && requestedModel !== undefined
    && requestedModel.length > 0
    && !sameModel(attemptedModel, requestedModel);
}

export function RunAttribution({
  attribution,
  status,
}: {
  readonly attribution?: RunAttributionValue;
  readonly status: RunStatus | WebMessageStatus;
}) {
  if (attribution === undefined) return null;
  const fallback = attribution.disposition === "fallback";
  const effectiveEffort = effortLabel((attribution.executed ?? attribution.attempted)?.effectiveEffort);
  const requestedEffort = effortLabel(attribution.requested.effort);
  const effortChanged = effectiveEffort !== undefined
    && (requestedEffort === undefined || canonicalEffort(effectiveEffort) !== canonicalEffort(requestedEffort));
  const hasDetails = attribution.transitions.length > 0
    || attribution.retries.length > 0
    || attribution.truncated === true
    || effectiveEffort !== undefined;

  return (
    <div
      className={`run-attribution${fallback ? " is-fallback" : ""}`}
      data-run-attribution={attribution.disposition}
      {...(fallback ? { role: "status", "aria-label": "Model fallback" } : {})}
    >
      <div className="run-attribution-summary">
        {fallback && <strong className="run-attribution-warning">Fallback</strong>}
        <span>{runAttributionSummary(attribution, status)}</span>
        {effortChanged && (
          <span className="run-attribution-effort">
            {requestedEffort === undefined ? `Effective ${effectiveEffort}` : `Requested ${requestedEffort} → effective ${effectiveEffort}`}
          </span>
        )}
      </div>
      {hasDetails && (
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
