import { describe, expect, it } from "vitest";

import { isDeliverableConversation } from "../index.js";
import type { ChannelStartInput } from "../index.js";

type GenericChannelInputHasProcessJobs = "processJobs" extends keyof ChannelStartInput<unknown>
  ? true
  : false;

describe("isDeliverableConversation", () => {
  const nativeCallbackChannels = ["telegram", "slack"];

  it.each([
    "telegram:42",
    "slack:C1",
    "slack:C1:171.5",
  ])("accepts a native callback destination: %s", (conversationId) => {
    expect(isDeliverableConversation(conversationId, nativeCallbackChannels)).toBe(true);
  });

  it("preserves prefix-only classification while leaving target validation to the caller", () => {
    expect(isDeliverableConversation("telegram:", nativeCallbackChannels)).toBe(true);
  });

  it.each([
    "whatsapp:123@s.whatsapp.net",
    "webhook:request-1",
    "telegram-bot:42",
    "telegram",
    ":missing-channel",
    "",
  ])("rejects a non-callback destination: %s", (conversationId) => {
    expect(isDeliverableConversation(conversationId, nativeCallbackChannels)).toBe(false);
  });

  it("supports caller-owned plugin channel policies without hardcoded prefixes", () => {
    expect(isDeliverableConversation("discord:channel-7", ["discord"])).toBe(true);
    expect(isDeliverableConversation("discord:channel-7", nativeCallbackChannels)).toBe(false);
  });
});

describe("ChannelStartInput capability boundary", () => {
  it("does not expose the owner-only process-job operator to channel drivers", () => {
    const hasProcessJobs: GenericChannelInputHasProcessJobs = false;
    expect(hasProcessJobs).toBe(false);
  });
});
