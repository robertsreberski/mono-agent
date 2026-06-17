export { createPhoenixRunExporter, DEFAULT_PHOENIX_ENDPOINT } from "./phoenix-exporter.js";
export type { PhoenixRunExporterDeps } from "./phoenix-exporter.js";

export { buildOtlpTraceRequest } from "./otlp-json.js";
export type {
  BuildOtlpTraceRequestInput,
  OtlpAnyValue,
  OtlpAttribute,
  OtlpIdFactory,
  OtlpResourceSpans,
  OtlpScopeSpans,
  OtlpSpan,
  OtlpStatus,
  OtlpTraceRequest,
} from "./otlp-json.js";

export { postOtlpJson } from "./transport.js";
export type { PostOtlpJsonInput, PostOtlpJsonResult } from "./transport.js";
