import { effortFullName, type EffortSignal } from "./route-label";

/**
 * Quiet inline route label: recognisable model and plain-language effort.
 *
 * A `span`, never a button: rows already navigate, so the badge must not
 * swallow clicks, keys or disclosure. Full identity lives in `aria-label`
 * and `title`; existing settings and routing disclosures carry touch detail.
 */
export function RouteBadge({
  modelShort,
  effortShort,
  effortSignal,
  label,
  title,
  compact = false,
  fallback = false,
  requestedOnly = false,
}: {
  readonly modelShort: string;
  readonly effortShort: string;
  readonly effortSignal?: EffortSignal;
  /** Accessible name; always the full route, never the short words. */
  readonly label: string;
  /** Hover detail; mirrors the accessible name. */
  readonly title: string;
  /** Even smaller activity variant: less padding first, same type floor. */
  readonly compact?: boolean;
  /** A fallback stays flagged while folded; colour is never the only signal. */
  readonly fallback?: boolean;
  /** Requested-only never poses as a confirmed run. */
  readonly requestedOnly?: boolean;
}) {
  return (
    <span
      className={[
        "route-badge",
        compact ? "is-compact" : "",
        fallback ? "is-fallback" : "",
        requestedOnly ? "is-requested" : "",
      ].filter(Boolean).join(" ")}
      role="img"
      aria-label={label}
      title={effortSignal === undefined ? title : `${title}. Currently available effort: ${effortSignal.levels.map(effortFullName).join(" → ")}; empty bars mean off.`}
    >
      {fallback && <span className="route-badge-flag" aria-hidden="true">!</span>}
      <span className="route-badge-model">{modelShort}</span>
      {effortSignal === undefined ? <>
        <span className="route-badge-sep" aria-hidden="true">·</span>
        <span className="route-badge-effort">{effortShort}</span>
      </> : (
        <span className="effort-signal" aria-hidden="true" data-levels={effortSignal.levels.length} data-filled={effortSignal.filled}>
          {effortSignal.levels.map((level, index) => <i
            key={level}
            className={index < effortSignal.filled ? "is-filled" : undefined}
            style={{ height: `${effortSignal.levels.length === 1 ? 10 : 3 + 7 * index / (effortSignal.levels.length - 1)}px` }}
          />)}
        </span>
      )}
    </span>
  );
}
