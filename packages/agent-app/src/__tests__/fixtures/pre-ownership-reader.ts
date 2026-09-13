// Exact-key compatibility seam from the final strict readers before durable
// subagent ownership was added. These fixtures intentionally model only the
// old readers' unknown-field rejection, not a second product validator.
const registryKeys = new Set([
  "id", "conversationId", "name", "systemPrompt", "definition", "sessionId", "sessionsRoot", "status", "turns", "usage",
  "createdAt", "updatedAt", "lastStatus", "lastAnswerHead", "pendingQuestion", "reservation",
]);

const jobKeys = new Set([
  "schemaVersion", "generation", "jobId", "tool", "state", "summary", "agentIncarnation", "kind", "instanceId", "childStillBusy",
  "subagentQuestion", "subagentProgress", "processIncarnation", "pid", "pgid", "sandboxSettingsPath", "argvSummary", "cwd", "envKeys",
  "origin", "chainDepth", "wakeOnCompletion", "maxRuntimeMs", "maxOutputBytes", "previewChars", "admittedAt", "queueDeadlineAt",
  "startedAt", "runtimeDeadlineAt", "completedAt", "exitCode", "signal", "durationMs", "stdoutBytes", "stderrBytes", "truncated",
  "preview", "stdoutRef", "stderrRef", "cancelRequested", "wake", "lastError",
]);

export const preOwnershipRegistryReaderAcceptsKeys = (value: object): boolean =>
  Object.keys(value).every((key) => registryKeys.has(key));

export const preOwnershipJobReaderAcceptsKeys = (value: object): boolean =>
  Object.keys(value).every((key) => jobKeys.has(key));
