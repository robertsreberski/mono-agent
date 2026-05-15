import type { FieldGroup } from "../schema/types.js";

/**
 * Runtime config injected by the bridge into window.__CONFIG_UI__
 * before the SPA bundle loads.
 */
export interface ConfigUiRuntime {
  readonly baseUrl: string;
  readonly token: string;
  readonly fieldGroupIds: readonly string[];
}

declare global {
  interface Window {
    __CONFIG_UI__?: ConfigUiRuntime;
  }
}

export function readRuntime(): ConfigUiRuntime {
  if (typeof window !== "undefined" && window.__CONFIG_UI__) {
    return window.__CONFIG_UI__;
  }
  return { baseUrl: "", token: "", fieldGroupIds: [] };
}

export type { FieldGroup };
