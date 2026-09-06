import {
  cycleDataModeSetting,
  dataModeLabel,
  useDataMode,
  useDataModeSetting,
} from "../data-mode";
import { dataUsageRatePerMinute, formatDataBytes, useDataUsage } from "../data-usage";
import { Icon } from "./Icon";

/**
 * The mode this console is running in, and what it has spent so far.
 *
 * Both halves matter and neither works alone: a data mode nobody can see is a
 * setting nobody will find on the phone it exists for, and a byte counter with
 * no control next to it is a number nobody can act on. Tapping cycles
 * Auto → Lean → Full, so the whole feature is one control in the sidebar footer.
 *
 * The rate appears only once the session has run long enough for one to mean
 * anything — see {@link dataUsageRatePerMinute}.
 */
export function DataModeIndicator() {
  const setting = useDataModeSetting();
  const mode = useDataMode();
  const usage = useDataUsage();
  const rate = dataUsageRatePerMinute();
  const label = dataModeLabel(setting, mode);
  // A total the browser measured and a total the console added up from body
  // lengths are two different claims, and the second one overstates a compressed
  // response. The tilde is the difference, and the accessible name says it in
  // words rather than in punctuation.
  const spent = `${usage.measured ? "" : "~"}${formatDataBytes(usage.bytes)}`;
  const spoken = usage.measured
    ? formatDataBytes(usage.bytes)
    : `an estimated ${formatDataBytes(usage.bytes)}`;
  return (
    <button
      type="button"
      className={`data-mode-indicator is-${mode}`}
      aria-label={`Data ${label}, ${spoken} this session. Change data mode.`}
      title="Auto follows the connection; Lean loads pictures and apps only when you ask."
      onClick={() => { cycleDataModeSetting(); }}
    >
      <Icon name="activity" size={14} />
      <span className="data-mode-name">{label}</span>
      <span className="data-mode-bytes">
        {rate > 0 ? `${spent} · ${formatDataBytes(rate)}/min` : spent}
      </span>
    </button>
  );
}
