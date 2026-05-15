import type { FieldDefinition } from "../../schema/types.js";

interface SecretMarker {
  readonly __secret: true;
  readonly set: boolean;
}

function isSecretMarker(value: unknown): value is SecretMarker {
  return (
    typeof value === "object" && value !== null && (value as Record<string, unknown>).__secret === true
  );
}

export interface FieldInputProps {
  readonly field: FieldDefinition;
  /** Raw value from the JSON config (may be the secret marker for kind=secret). */
  readonly currentValue: unknown;
  /** Editor value when the user has touched the field. undefined means "use currentValue". */
  readonly draftValue: string | undefined;
  readonly onChange: (next: string) => void;
}

export function FieldInput({ field, currentValue, draftValue, onChange }: FieldInputProps): React.JSX.Element {
  const labelId = `field-${field.id}`;
  const isSecret = field.kind === "secret";
  const secretMarker = isSecret && isSecretMarker(currentValue) ? currentValue : null;
  const displayValue = (() => {
    if (draftValue !== undefined) {
      return draftValue;
    }
    if (isSecret) {
      return ""; // secrets are always write-only
    }
    if (currentValue === undefined || currentValue === null) {
      return "";
    }
    if (Array.isArray(currentValue)) {
      return currentValue.map(String).join(", ");
    }
    return String(currentValue);
  })();

  return (
    <div className="field">
      <label htmlFor={labelId} className="field__label">
        {field.label}
        {field.required ? <span className="field__required" aria-label="required"> *</span> : null}
        {isSecret && secretMarker?.set ? (
          <span className="field__badge" aria-label="secret is set">SET</span>
        ) : null}
      </label>
      {field.description ? <p className="field__description">{field.description}</p> : null}
      {renderControl(field, labelId, displayValue, onChange)}
    </div>
  );
}

function renderControl(
  field: FieldDefinition,
  id: string,
  value: string,
  onChange: (next: string) => void,
): React.JSX.Element {
  switch (field.kind) {
    case "select":
      return (
        <select
          id={id}
          className="field__select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— unset —</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      );
    case "switch":
      return (
        <input
          id={id}
          type="checkbox"
          className="field__switch"
          checked={value === "true"}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
        />
      );
    case "integer":
      return (
        <input
          id={id}
          type="number"
          className="field__input"
          inputMode="numeric"
          {...(field.min !== undefined ? { min: field.min } : {})}
          {...(field.max !== undefined ? { max: field.max } : {})}
          {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "secret":
      return (
        <input
          id={id}
          type="password"
          className="field__input"
          autoComplete="new-password"
          placeholder="Set new value to replace"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "csv":
    case "string":
    case "path":
    default:
      return (
        <input
          id={id}
          type="text"
          className="field__input"
          {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
