/**
 * Quiet split badge: short model name plus a distinct effort token.
 *
 * A `span`, never a button: rows already navigate, so the badge must not
 * swallow clicks, keys or disclosure. Full identity lives in `aria-label`
 * and `title`; existing settings and routing disclosures carry touch detail.
 */
export function RouteBadge({
  modelShort,
  effortShort,
  label,
  title,
  compact = false,
  fallback = false,
  requestedOnly = false,
}: {
  readonly modelShort: string;
  readonly effortShort: string;
  /** Accessible name; always the full route, never the short words. */
  readonly label: string;
  /** Mouse/long-press detail; mirrors the accessible name. */
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
      title={title}
    >
      {fallback && <span className="route-badge-flag" aria-hidden="true">!</span>}
      <span className="route-badge-model">{modelShort}</span>
      <span className="route-badge-sep" aria-hidden="true">|</span>
      <span className="route-badge-effort">{effortShort}</span>
    </span>
  );
}
