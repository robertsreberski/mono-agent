import { Icon } from "../Icon";

/** Controlled, and nothing else: the query and what it means belong upstream. */
export function DashboardSearch({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="dashboard-search">
      <Icon name="search" size={16} />
      <span className="sr-only">Search conversations</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search conversations"
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
