import type { FieldGroup } from "@mono-agent/settings/field-groups";

/**
 * Runtime config injected by the server into window.__OPERATOR_CONSOLE__
 * before the SPA bundle loads.
 */
export interface OperatorConsoleRuntime {
  readonly baseUrl: string;
  readonly token: string;
  readonly fieldGroupIds: readonly string[];
}

declare global {
  interface Window {
    __OPERATOR_CONSOLE__?: OperatorConsoleRuntime;
  }
}

export function readRuntime(): OperatorConsoleRuntime {
  if (typeof window !== "undefined" && window.__OPERATOR_CONSOLE__) {
    return window.__OPERATOR_CONSOLE__;
  }
  return { baseUrl: "", token: "", fieldGroupIds: [] };
}

export type { FieldGroup };
