import { expect, it } from "vitest";
import * as boundary from "../index.js";

it("exposes only the curated package-root runtime boundary", () => {
  expect(Object.keys(boundary).sort()).toEqual([
    "CONTINUITY_USER_VERSION",
    "CONVERSATION_HISTORY_VERSION_MAX_BYTES",
    "ConversationHarnessError",
    "ConversationHarnessFailureError",
    "HOST_TURN_CONTEXT_GUIDANCE",
    "TOOL_HISTORY_APPLICATION_ID",
    "TOOL_HISTORY_DATABASE",
    "TOOL_HISTORY_DIRECTORY",
    "TOOL_HISTORY_OWNER_DATABASE",
    "TOOL_HISTORY_USER_VERSION",
    "ToolHistoryReader",
    "ToolHistoryWriter",
    "ToolPolicyError",
    "acquireToolHistoryWriter",
    "bindProcessJobLiveInput",
    "classifyContinuationMcpServerTransport",
    "composeHostTurnEnvelope",
    "continuityGenerationId",
    "continuityRecordId",
    "createContinuityParticipant",
    "createConversationHarness",
    "createConversationResponder",
    "createDurableHistoryStore",
    "createInMemoryHistoryStore",
    "createLiveInputMailbox",
    "createLiveSessionManager",
    "createSessionRuntimeResolver",
    "createSkillsCache",
    "createToolHistoryArtifactSink",
    "createToolPolicy",
    "currentProcessIncarnation",
    "failClosedToolPolicy",
    "formatHostCapabilities",
    "isProcessAlive",
    "isProcessIncarnationLive",
    "isReadSkillCompatibleName",
    "isSameProcessIncarnation",
    "isStdioMcpServerSpec",
    "loadSelectedSkills",
    "loadSkillIndexFromDirectory",
    "loadToolPolicyFromJsonFile",
    "loadToolPolicyFromJsonFileSync",
    "logicalConversationIdForFence",
    "processIncarnationFromJson",
    "readProcessIncarnation",
    "renderSkillIndexSection",
    "toolHistoryDiskUsage",
    "toolHistoryLogicalConversationId",
    "toolPolicyToRuntimeOptions"
  ]);
});

it("renames errors without changing failure codes, messages or details", () => {
  const details = { retryable: true };
  const error = new boundary.ConversationHarnessError("example_failure", "Example failure.", details);
  expect(error).toMatchObject({ name: "ConversationHarnessError", failureKind: "example_failure", message: "Example failure.", details });
  const failure = { kind: "example_failure", message: "Example failure.", details };
  expect(new boundary.ConversationHarnessFailureError(failure)).toMatchObject({ name: "ConversationHarnessFailureError", message: failure.message, failure });
  for (const old of ["AgentHarnessError", "AgentHarnessFailureError", "createAgentHarness", "createAgentResponder"]) {
    expect(Object.hasOwn(boundary, old)).toBe(false);
  }
});
