import type { FieldDefinition } from "@mono-agent/settings/field-groups";
import { Badge } from "./ui/badge.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Select } from "./ui/select.js";
import { Switch } from "./ui/switch.js";

interface SecretMarker {
  readonly __secret: true;
  readonly set: boolean;
}

function isSecretMarker(value: unknown): value is SecretMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__secret === true
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

export function FieldInput({
  field,
  currentValue,
  draftValue,
  onChange,
}: FieldInputProps): React.JSX.Element {
  const labelId = `field-${field.id}`;
  const isSecret = field.kind === "secret";
  const secretMarker =
    isSecret && isSecretMarker(currentValue) ? currentValue : null;
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
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={labelId} className="flex flex-wrap items-center gap-2">
        <span>{field.label}</span>
        {field.required ? (
          <span aria-label="required" className="text-destructive">
            *
          </span>
        ) : null}
        {isSecret && secretMarker?.set ? (
          <Badge variant="secondary" aria-label="secret is set">
            SET
          </Badge>
        ) : null}
      </Label>
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
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
        <Select
          id={id}
          value={value}
          placeholder="— unset —"
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      );
    case "switch":
      return (
        <Switch
          id={id}
          checked={value === "true"}
          onCheckedChange={(next) => onChange(next ? "true" : "false")}
        />
      );
    case "integer":
      return (
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          {...(field.min !== undefined ? { min: field.min } : {})}
          {...(field.max !== undefined ? { max: field.max } : {})}
          {...(field.placeholder !== undefined
            ? { placeholder: field.placeholder }
            : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "secret":
      return (
        <Input
          id={id}
          type="password"
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
        <Input
          id={id}
          type="text"
          {...(field.placeholder !== undefined
            ? { placeholder: field.placeholder }
            : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
