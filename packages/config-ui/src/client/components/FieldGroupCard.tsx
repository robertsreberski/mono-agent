import type { MonoAgentConfigJson } from "@worklab-ai/config";

import type { FieldDefinition, FieldGroup } from "../../schema/types.js";
import { FieldInput } from "./FieldInput.js";

export interface FieldGroupCardProps {
  readonly group: FieldGroup;
  readonly config: MonoAgentConfigJson;
  readonly drafts: Readonly<Record<string, string>>;
  readonly onChange: (field: FieldDefinition, next: string) => void;
}

export function FieldGroupCard({ group, config, drafts, onChange }: FieldGroupCardProps): React.JSX.Element {
  return (
    <section className="card" aria-labelledby={`group-${group.id}`}>
      <header className="card__header">
        <h2 id={`group-${group.id}`} className="card__title">{group.label}</h2>
        {group.description ? <p className="card__description">{group.description}</p> : null}
      </header>
      <div className="card__body">
        {group.fields.map((field) => (
          <FieldInput
            key={field.id}
            field={field}
            currentValue={readPath(config, field.path)}
            draftValue={drafts[field.id]}
            onChange={(next) => onChange(field, next)}
          />
        ))}
      </div>
    </section>
  );
}

function readPath(json: MonoAgentConfigJson, path: readonly string[]): unknown {
  let cursor: unknown = json;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
