import type { ValidationSection } from "./doctor-types.js";

/** Built-in tracing is unconditional in the app host, not an optional exporter. */
export function observabilitySection(): ValidationSection {
  return {
    id: "observability", label: "Built-in tracing", status: "ok",
    details: ["Built-in tracing is already enabled by the app host. External trace exporters are not supported."],
  };
}
