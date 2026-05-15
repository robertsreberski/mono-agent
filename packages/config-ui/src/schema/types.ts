export type FieldKind =
  | "string"
  | "secret"
  | "select"
  | "switch"
  | "path"
  | "csv"
  | "integer";

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface FieldDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: FieldKind;
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly options?: readonly FieldOption[];
  readonly min?: number;
  readonly max?: number;
  /** dotted path into MonoAgentConfigJson, e.g. ["runtime","model"]. */
  readonly path: readonly string[];
}

export interface FieldGroup {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly fields: readonly FieldDefinition[];
}

export type FieldGroupRegistry = readonly FieldGroup[];
