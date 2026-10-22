import type { WebApiDtos } from "../../src/api-contract.js";

type Dto = keyof WebApiDtos | "NoBody" | "Binary" | "Html";
export interface ContractRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly requestType: Dto;
  readonly responseType: Dto;
  readonly successStatus: readonly number[];
  /** For native clients without an Origin header. See originPolicy. */
  readonly requiresClaimedOrigin: boolean;
  readonly originPolicy: "host" | "exact" | "claimed";
  readonly queryType?: keyof WebApiDtos;
  readonly resultStatuses?: readonly number[];
  readonly responseContentType?: string;
}

function route(
  method: ContractRoute["method"], path: string, requestType: Dto, responseType: Dto,
  successStatus: readonly number[] = [200], originPolicy: ContractRoute["originPolicy"] = "host",
  extra: Pick<ContractRoute, "queryType" | "resultStatuses" | "responseContentType"> = {},
): ContractRoute {
  return { method, path: path === "/healthz" ? path : `/api/v1${path}`, requestType, responseType,
    successStatus, requiresClaimedOrigin: originPolicy !== "host", originPolicy, ...extra };
}

/** Deliberately explicit: route discovery is independent, so new handlers fail the gate. */
export const ROUTES: readonly ContractRoute[] = [
  route("GET", "/healthz", "NoBody", "ApiHealth"),
  route("GET", "/mcp-app-proxy", "NoBody", "Html", [200], "host", { responseContentType: "text/html" }),
  route("GET", "/bootstrap", "NoBody", "ApiBootstrap", [200], "host", { queryType: "ApiBootstrapQuery" }),
  route("PATCH", "/agents/:id", "ApiPatchAgent", "ApiAgent"),
  route("PUT", "/agents/:id/run-defaults", "ApiPutRunDefaults", "ApiAgent"),
  route("DELETE", "/agents/:id/run-defaults", "NoBody", "ApiAgent"),
  route("POST", "/agents/:id/provider-usage/refresh", "ApiEmpty", "ApiProviderUsage", [200], "exact", { queryType: "ApiProviderQuery" }),
  route("GET", "/agents/:id/provider-usage", "NoBody", "ApiProviderUsage", [200], "exact", { queryType: "ApiProviderQuery" }),
  route("POST", "/agents/:id/restart", "ApiEmpty", "ApiRestart", [200], "exact"),
  route("GET", "/agents/:id/restart", "NoBody", "ApiLatestRestart", [200], "exact"),
  route("GET", "/agents/:id/restart/:operationId", "NoBody", "ApiRestart", [200], "exact"),
  route("GET", "/agents/:id/provider-auth", "NoBody", "ApiProviderAuth", [200], "exact"),
  route("POST", "/agents/:id/provider-auth/sessions", "ApiAuthStart", "ApiAuthSession", [201], "exact"),
  route("GET", "/agents/:id/provider-auth/sessions/:sessionId", "NoBody", "ApiAuthSession", [200], "exact"),
  route("POST", "/agents/:id/provider-auth/sessions/:sessionId/input", "ApiAuthInput", "ApiAuthSession", [200], "exact"),
  route("DELETE", "/agents/:id/provider-auth/sessions/:sessionId", "NoBody", "NoBody", [204], "exact"),
  route("POST", "/agents/:id/provider-auth/checks", "ApiAuthCheckStart", "ApiAuthCheck", [201], "exact"),
  route("GET", "/agents/:id/provider-auth/checks/:checkId", "NoBody", "ApiAuthCheck", [200], "exact"),
  route("DELETE", "/agents/:id/provider-auth/checks/:checkId", "NoBody", "NoBody", [204], "exact"),
  route("GET", "/agents/:id/skills", "NoBody", "ApiSkills"),
  route("GET", "/agents/:id/cron", "NoBody", "ApiCronOverview"),
  route("GET", "/agents/:id/cron/config-view", "NoBody", "ApiCronConfig"),
  route("GET", "/agents/:id/cron/jobs/:jobId/runs", "NoBody", "ApiCronRuns", [200], "host", { queryType: "ApiCronRunsQuery" }),
  route("GET", "/agents/:id/models", "NoBody", "ApiModels", [200], "host", { queryType: "ApiModelsQuery" }),
  route("GET", "/agents/:id/cron/jobs/:jobId/runs/:runId", "NoBody", "ApiCronRun"),
  route("POST", "/agents/:id/cron/jobs/:jobId/runs/:runId/reply-threads", "ApiCronReply", "ApiCronReceipt", [200, 201], "exact"),
  route("POST", "/agents/:id/cron/jobs/:jobId/run", "ApiCronAction", "ApiCronRunResult", [200], "exact", { resultStatuses: [200, 428] }),
  route("POST", "/agents/:id/cron/jobs/:jobId/effective-enabled", "ApiCronEnable", "ApiCronEnableResult", [200], "exact", { resultStatuses: [200, 428] }),
  route("POST", "/threads", "ApiCreateThread", "ApiThread", [201]),
  route("GET", "/tags", "NoBody", "ApiTags", [200], "host", { queryType: "ApiSourceQuery" }),
  route("POST", "/tags", "ApiCreateTag", "ApiTag", [201]),
  route("PATCH", "/tags/:id", "ApiPatchTag", "ApiTag"),
  route("DELETE", "/tags/:id", "NoBody", "NoBody", [204]),
  route("GET", "/projects", "NoBody", "ApiProjects", [200], "host", { queryType: "ApiSourceQuery" }),
  route("POST", "/projects", "ApiCreateProject", "ApiProject", [201]),
  route("PATCH", "/projects/:id", "ApiPatchProject", "ApiProject"),
  route("DELETE", "/projects/:id", "NoBody", "NoBody", [204]),
  route("GET", "/threads", "NoBody", "ApiThreadPage", [200], "host", { queryType: "ApiThreadsQuery" }),
  route("GET", "/threads/search", "NoBody", "ApiSearch", [200], "host", { queryType: "ApiSearchQuery" }),
  route("GET", "/threads/active", "NoBody", "ApiActiveThreads"),
  route("GET", "/threads/:threadId/messages/:messageId/tool-calls/:toolCallId", "NoBody", "ApiToolCall"),
  route("POST", "/threads/:threadId/messages/:messageId/parts/:partId/restart", "ApiEmpty", "ApiRestart", [200], "exact"),
  route("GET", "/threads/:threadId/messages/:messageId", "NoBody", "ApiMessage", [200], "host", { queryType: "ApiFullQuery" }),
  route("GET", "/threads/:id/usage", "NoBody", "ApiThreadUsage"),
  route("GET", "/threads/:id", "NoBody", "ApiThreadDetail", [200], "host", { queryType: "ApiFullQuery" }),
  route("GET", "/threads/:id/messages", "NoBody", "ApiMessagePage", [200], "host", { queryType: "ApiMessagesQuery" }),
  route("POST", "/threads/:threadId/messages/:messageId/reply-attachments/:partId/access", "NoBody", "ApiAttachmentAccess", [200], "exact"),
  route("GET", "/threads/:threadId/messages/:messageId/reply-attachments/:partId/content", "NoBody", "Binary", [200], "host", { queryType: "ApiCapabilityQuery", responseContentType: "*/*" }),
  route("POST", "/threads/:threadId/messages/:messageId/mcp-apps/:partId/access", "NoBody", "ApiMcpAppAccess", [200], "exact"),
  route("GET", "/threads/:threadId/messages/:messageId/mcp-apps/:partId", "NoBody", "ApiMcpAppResource", [200], "host", { queryType: "ApiCapabilityQuery" }),
  route("POST", "/threads/:threadId/messages/:messageId/mcp-apps/:partId/requests", "ApiMcpAppRequest", "ApiMcpAppResult", [200], "exact", { queryType: "ApiCapabilityQuery" }),
  route("GET", "/threads/:id/jobs/:jobId", "NoBody", "ApiJob"),
  route("GET", "/threads/:id/wake-schedule", "NoBody", "ApiWakeSchedule"),
  route("POST", "/threads/:id/wake-schedule", "ApiCreateWake", "ApiWakeSchedule", [201], "exact"),
  route("PUT", "/threads/:id/wake-schedule", "ApiPutWake", "ApiWakeSchedule", [200], "exact"),
  route("PATCH", "/threads/:id/wake-schedule", "ApiPatchWake", "ApiWakeSchedule", [200], "exact"),
  route("DELETE", "/threads/:id/wake-schedule", "ApiDeleteWake", "NoBody", [204], "exact"),
  route("PATCH", "/threads/:id", "ApiPatchThread", "ApiThread"),
  route("DELETE", "/threads/:id", "NoBody", "NoBody", [204], "host", { queryType: "ApiDeleteThreadQuery" }),
  route("POST", "/threads/:id/compact", "ApiEmpty", "ApiCompaction"),
  route("POST", "/threads/:id/turns", "ApiStartTurn", "ApiStartedTurn", [202]),
  route("POST", "/threads/:id/submissions", "ApiStartSubmission", "ApiSubmissionReceipt", [202], "host", { resultStatuses: [202, 409] }),
  route("GET", "/threads/:id/submissions/:submissionId", "NoBody", "ApiSubmissionReceipt"),
  route("POST", "/threads/:id/live-input", "ApiLiveInput", "ApiLiveInputReceipt", [202]),
  route("POST", "/threads/:id/cancel", "ApiCancel", "ApiCancelled", [202]),
  route("GET", "/threads/:id/ask", "NoBody", "ApiAsk"),
  route("GET", "/threads/:id/ask/:interactionId", "NoBody", "ApiAsk"),
  route("POST", "/threads/:id/ask", "ApiAnswerAsk", "ApiAskResult"),
  route("PUT", "/push/subscriptions", "ApiPushSubscriptionInput", "ApiPushSubscription", [201], "exact"),
  route("GET", "/push/subscriptions/:id", "NoBody", "ApiPushSubscription", [200], "claimed"),
  route("DELETE", "/push/subscriptions/:id", "NoBody", "NoBody", [204], "exact"),
  route("POST", "/push/subscriptions/:id/test", "NoBody", "ApiPushSubscription", [202], "exact"),
  route("POST", "/push/events/:eventId/ack", "ApiPushAck", "NoBody", [204], "exact"),
  route("POST", "/uploads", "ApiCreateUpload", "ApiUpload", [201]),
  route("PUT", "/uploads/:id/content", "Binary", "ApiUpload"),
  route("DELETE", "/uploads/:id", "NoBody", "NoBody", [204]),
  route("GET", "/uploads/:id/content", "NoBody", "Binary", [200], "host", { responseContentType: "*/*" }),
  route("GET", "/events", "NoBody", "ApiEvent", [200], "host", { queryType: "ApiEventsQuery", responseContentType: "text/event-stream" }),
];
