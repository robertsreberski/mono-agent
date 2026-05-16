import type { MonoAgentConfigJson } from "@worklab-ai/config";

import type { FieldDefinition, FieldGroup } from "../../schema/types.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.js";
import { FieldInput } from "./FieldInput.js";

export interface FieldGroupCardProps {
  readonly group: FieldGroup;
  readonly config: MonoAgentConfigJson;
  readonly drafts: Readonly<Record<string, string>>;
  readonly onChange: (field: FieldDefinition, next: string) => void;
}

export function FieldGroupCard({
  group,
  config,
  drafts,
  onChange,
}: FieldGroupCardProps): React.JSX.Element {
  return (
    <Card aria-labelledby={`group-${group.id}`} className="min-w-0">
      <CardHeader>
        <CardTitle id={`group-${group.id}`}>{group.label}</CardTitle>
        {group.description ? (
          <CardDescription>{group.description}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="grid min-w-0 gap-5">
        {group.fields.map((field) => (
          <FieldInput
            key={field.id}
            field={field}
            currentValue={readPath(config, field.path)}
            draftValue={drafts[field.id]}
            onChange={(next) => onChange(field, next)}
          />
        ))}
      </CardContent>
    </Card>
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
