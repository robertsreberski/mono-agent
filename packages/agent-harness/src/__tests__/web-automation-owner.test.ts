import { describe, expect, it } from "vitest";
import { isOwnerHumanTurn } from "../harness/request-routing.js";

const base = { conversationId: "fictional-wake", userMessage: "Fictional automation", abortSignal: new AbortController().signal };
describe("trusted web automation owner boundary", () => {
  it.each(["admin", "user", undefined])("never grants owner-human authority to trigger with %s editor", (role) => {
    expect(isOwnerHumanTurn({ ...base, captureSpeakerKind: "trigger", metadata: { source: "web", ...(role === undefined ? {} : { webActor: { role } }) } })).toBe(false);
  });
  it("preserves legacy owner-human and authenticated role semantics", () => {
    expect(isOwnerHumanTurn({ ...base, captureSpeakerKind: "human-turn", metadata: { source: "web" } })).toBe(true);
    expect(isOwnerHumanTurn({ ...base, captureSpeakerKind: "human-turn", metadata: { source: "web", webActor: { role: "admin" } } })).toBe(true);
    expect(isOwnerHumanTurn({ ...base, captureSpeakerKind: "human-turn", metadata: { source: "web", webActor: { role: "user" } } })).toBe(false);
  });
});
