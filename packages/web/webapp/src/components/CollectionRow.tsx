import type { IconName } from "./Icon";
import { Icon } from "./Icon";

export function CollectionRow({
  label,
  icon,
  count,
  countA11yLabel,
  onSelect,
}: {
  readonly label: string;
  readonly icon: IconName;
  readonly count?: number;
  readonly countA11yLabel?: string;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="collection-row"
      aria-label={`Open ${label} collection`}
      onClick={onSelect}
    >
      <span className="collection-icon"><Icon name={icon} size={16} /></span>
      <span className="collection-label">{label}</span>
      {count !== undefined && (
        <span className="collection-count" aria-label={countA11yLabel}>{count}</span>
      )}
      <Icon name="chevron" size={15} />
    </button>
  );
}
