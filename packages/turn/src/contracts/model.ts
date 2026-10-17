// Shared turn contracts; no runtime implementation imports.

/** Runtime-result and telemetry label; Pi is the sole runtime bridge. */
export type RuntimeSdkId = "pi";

/** Direct Pi bridge id returned by src/runtime/bridges.js. */
export type RuntimeBridgeId = "pi";

export type RuntimeModelRef = {
  /** Pi provider id. */
  provider: string;
  /** Provider model id. */
  model: string;
  /** Canonical `<provider>:<model>` reference. */
  reference: string;
};
