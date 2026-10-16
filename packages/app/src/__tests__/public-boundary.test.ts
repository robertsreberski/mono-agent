import { expect, it } from "vitest";
import * as boundary from "../index.js";

it("exposes only the curated package-root runtime boundary", () => {
  expect(Object.keys(boundary).sort()).toEqual([
    "consumerContractNames",
    "createConfiguredAgentHarness",
    "createConfiguredAgentResponder",
    "createConfiguredAgentRuntime",
    "createConfiguredMemory",
    "createCronChannelDriver",
    "createOpenAIApiChannelDriver",
    "createSlackChannelDriver",
    "createTelegramChannelDriver",
    "createWebhookChannelDriver",
    "defaultChannelDrivers",
    "resolveAppArtifactDir",
    "resolveAppTraceStaleAfterMs",
    "resolveChannelDrivers",
    "startMonoAgentApp",
    "validateConsumerContractFixture"
  ]);
});
