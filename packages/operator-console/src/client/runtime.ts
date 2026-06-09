import type { FieldGroup } from "@worklab-ai/settings/field-groups";

/**
 * Runtime config injected by the server into window.__OPERATOR_CONSOLE__
 * before the SPA bundle loads.
 */
export interface OperatorConsoleRuntime {
  readonly baseUrl: string;
  readonly token: string;
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
  return { baseUrl: "", token: "" };
}

export type { FieldGroup };
