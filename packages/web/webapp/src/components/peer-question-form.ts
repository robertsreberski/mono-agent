/**
 * Display-only summary of an untrusted PeerAgent ACP form. Mirrors
 * `describePeerQuestionForm` in agent-contracts: the browser bundle may not
 * load server contract modules, and the peer bridge remains the sole validator.
 */
export interface PeerQuestionFieldView {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly options: readonly string[];
  readonly required: boolean;
  readonly multiple: boolean;
  readonly freeText: boolean;
}

const TEXT_LIMIT = 200;
const FIELD_LIMIT = 20;
const OPTION_LIMIT = 12;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/gu, " ").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > TEXT_LIMIT ? `${trimmed.slice(0, TEXT_LIMIT - 1)}…` : trimmed;
}

function options(schema: Record<string, unknown>): string[] {
  for (const key of ["oneOf", "anyOf"] as const) {
    const choices = schema[key];
    if (Array.isArray(choices)) {
      return choices.flatMap((choice) => {
        if (!isRecord(choice)) return [];
        const label = text(choice.title) ?? text(typeof choice.const === "string" ? choice.const : undefined);
        return label === undefined ? [] : [label];
      });
    }
  }
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.flatMap((value, index) => {
      // Only primitives are displayable; arbitrary JSON (objects, null) is skipped, never coerced.
      const primitive = typeof value === "string" ? value
        : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
      const label = text(names[index]) ?? text(primitive);
      return label === undefined ? [] : [label];
    });
  }
  return [];
}

export function describePeerQuestionForm(schema: unknown): readonly PeerQuestionFieldView[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string") : []);
  return Object.entries(schema.properties).slice(0, FIELD_LIMIT).flatMap(([key, property]): PeerQuestionFieldView[] => {
    if (!isRecord(property)) return [];
    const multiple = property.type === "array";
    const source = multiple && isRecord(property.items) ? property.items : property;
    const all = options(source);
    const bounded = all.length > OPTION_LIMIT ? [...all.slice(0, OPTION_LIMIT), `+${String(all.length - OPTION_LIMIT)} more`] : all;
    const description = text(property.description);
    return [{
      key: text(key) ?? "field",
      label: text(property.title) ?? text(key) ?? "field",
      ...(description === undefined ? {} : { description }),
      options: bounded,
      required: required.has(key),
      multiple,
      freeText: bounded.length === 0 && (source.type === "string" || source.type === undefined),
    }];
  });
}

export function peerQuestionStateLabel(state: "awaiting_answer" | "answered" | "expired" | "interrupted"): string {
  return state === "awaiting_answer" ? "Waiting for the agent's answer"
    : state === "answered" ? "Answered" : state === "expired" ? "Expired" : "Interrupted";
}
