import { manualCompactionDiagnostic, type AgentManualCompactionDiagnostic } from "@mono-agent/contracts";

/** Inspect locally, return only an allow-listed category and numeric HTTP status. */
export function classifyCompactionFailure(error: unknown): AgentManualCompactionDiagnostic {
  const data = error !== null && typeof error === "object" ? error as Record<string, any> : {};
  const message = String(data.message ?? data.errorMessage ?? "").slice(0, 8192).toLowerCase();
  const code = [data.code, data.name, data._tag].filter(Boolean).join(" ").toLowerCase();
  const status = data.status ?? data.statusCode ?? /\b(?:http[ :]*|status[ :]*)([45]\d\d)\b/i.exec(message)?.[1];
  const httpStatus = Number(status);
  const reason = data.code === "invalid_cut" ? "internal_error"
    : /timeout|timed out/.test(code + " " + message) ? "timeout"
    : /abort|cancel/.test(code) ? "cancelled"
    : httpStatus === 429 || /rate.limit|rate_limited/.test(message) ? "rate_limited"
    : httpStatus === 529 || httpStatus === 503 || /overload/.test(message) ? "provider_overloaded"
    : [401, 403].includes(httpStatus) || /auth/.test(code) ? "authentication"
    : /context.{0,30}(?:large|length|exceed)|prompt.{0,15}too.long|context_too_large/.test(message) ? "context_too_large"
    : /insufficient.*headroom|cannot fit a useful answer/.test(message) ? "insufficient_headroom"
    : /summary_refused|output_truncated|empty_summary|invalid_summary/.test(code + " " + message) ? "summary_refused"
    : /busy/.test(code) ? "busy" : "provider_error";
  return manualCompactionDiagnostic({ reason, httpStatus });
}
