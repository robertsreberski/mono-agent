import { Icon } from "../Icon";

/**
 * Controlled, and nothing else: the query and what it means belong upstream.
 * The label changes with the open collection, because the same field reads
 * conversations in one and automation jobs in the other.
 */
export function DashboardSearch({
  value,
  onChange,
  label = "Search conversations",
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label?: string;
}) {
  return (
    <label className="dashboard-search">
      <Icon name="search" size={16} />
      <span className="sr-only">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        type="search"
      />
      {value && (
        <button type="button" onClick={() => onChange("")} aria-label="Clear search">
          <Icon name="close" size={13} />
        </button>
      )}
    </label>
  );
}
