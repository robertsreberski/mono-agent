/** Version of the trusted non-human web automation boundary. */
export const OPERATOR_WEB_AUTOMATION_VERSION = 1;

/** Host-authored provenance, separate from the editor's access-scoping actor. */
export interface OperatorWebAutomation {
  readonly schema: typeof OPERATOR_WEB_AUTOMATION_VERSION;
}

/** Accept only the versioned marker; display metadata cannot grant provenance. */
export function parseOperatorWebAutomation(value: unknown): OperatorWebAutomation {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).some((key) => key !== "schema")
    || (value as Record<string, unknown>).schema !== OPERATOR_WEB_AUTOMATION_VERSION) {
    throw new TypeError("webAutomation must be a valid v1 automation marker.");
  }
  return { schema: OPERATOR_WEB_AUTOMATION_VERSION };
}
