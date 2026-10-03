import type { DurableSessionSalvage } from "@mono-agent/runtime-adapter";
import { redactProcessOutput } from "./process-output-redaction.js";
import { redactSecrets } from "./redact-secrets.js";

export interface SubagentSalvage {
  readonly completed: readonly { readonly name: string; readonly result: string }[];
  readonly outcomeUnknown: readonly { readonly name: string; readonly guidance: "do not assume done" }[];
  readonly omittedCompleted: number;
  readonly omittedUnknown: number;
  readonly draftText?: string;
  readonly additionalOutcomesUnknown: boolean;
}

/** Redact the whole value BEFORE bounding; never place raw Pi content in a wake. */
export function boundSubagentSalvage(raw: DurableSessionSalvage): SubagentSalvage {
  const clean = (input: string, limit: number): string => {
    const redacted = redactSecrets(redactProcessOutput(input, []), {
      fallback: "[unavailable]", environment: process.env, maxChars: 32 * 1024 * 1024,
    });
    return redacted
      // Over-redact through the next quote/delimiter: Windows path components
      // can contain spaces, and leaving a suffix is worse than dropping prose.
      .replace(/(?:\b[A-Za-z]:\\|\\\\[^\s\\]+\\[^\s\\]+)[^"'<>|\r\n]*/gu, "[path]")
      .replace(/(?:\/[\w.~-]+){2,}/gu, "[path]")
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .replaceAll("<untrusted_process_job_result>", "[untrusted_process_job_result]")
      .replaceAll("</untrusted_process_job_result>", "[/untrusted_process_job_result]")
      .slice(0, limit);
  };
  const completed = raw.completed.slice(-8).map((pair) => ({ name: clean(pair.name, 80), result: clean(pair.result, 240) }));
  const outcomeUnknown = raw.outcomeUnknown.slice(-8).map((call) => ({ name: clean(call.name, 80), guidance: "do not assume done" as const }));
  let snapshot: SubagentSalvage = {
    completed, outcomeUnknown,
    omittedCompleted: raw.omittedCompleted + Math.max(0, raw.completed.length - 8),
    omittedUnknown: raw.omittedUnknown + Math.max(0, raw.outcomeUnknown.length - 8),
    ...(raw.draftText ? { draftText: clean(raw.draftText, 600) } : {}),
    additionalOutcomesUnknown: raw.additionalOutcomesUnknown,
  };
  // Keep the whole serialized member bounded even when names or escape sequences expand.
  while (JSON.stringify(snapshot).length > 4000) {
    if (snapshot.draftText) snapshot = { ...snapshot, draftText: snapshot.draftText.slice(0, -40) };
    else if (snapshot.completed.length) snapshot = { ...snapshot, completed: snapshot.completed.slice(1), omittedCompleted: snapshot.omittedCompleted + 1 };
    else if (snapshot.outcomeUnknown.length) snapshot = { ...snapshot, outcomeUnknown: snapshot.outcomeUnknown.slice(1), omittedUnknown: snapshot.omittedUnknown + 1 };
    else break;
  }
  return snapshot;
}
