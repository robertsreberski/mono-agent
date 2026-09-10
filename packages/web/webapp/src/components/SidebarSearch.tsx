import { Icon } from "./Icon";

export function SidebarSearch({
  label,
  placeholder,
  value,
  onChange,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="thread-search">
      <Icon name="search" size={16} />
      <span className="sr-only">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="search"
      />
      {value && (
        <button type="button" onClick={() => onChange("")} aria-label={`Clear ${label.toLowerCase()}`}>
          <Icon name="close" size={13} />
        </button>
      )}
    </label>
  );
}
