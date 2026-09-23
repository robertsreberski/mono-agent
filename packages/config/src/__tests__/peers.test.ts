import { describe, expect, it } from "vitest";
import { resolveJsonMonoAgentConfig } from "../config.js";

const load = (peers: unknown) => resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: { model: "pi:openai-codex:gpt-5.5" },
  context: { identityPath: "IDENTITY.md" },
  peers: peers as never,
} });

describe("configured ACP peers", () => {
  it("loads exact named source IDs", () => {
    expect(load({ finance: { sourceId: "finance-ai" } }).peers?.finance).toEqual({ sourceId: "finance-ai" });
  });
  it.each([
    [null, /peers must be an object/u],
    [{ "Bad Name": { sourceId: "finance-ai" } }, /Invalid peer name/u],
    [{ finance: { sourceId: "finance-ai", token: "ignored" } }, /only a valid sourceId/u],
    [{ finance: { sourceId: "bad id" } }, /only a valid sourceId/u],
    [{ finance: { sourceId: "same" }, research: { sourceId: "same" } }, /Duplicate peer sourceId/u],
  ])("rejects invalid peer definitions", (peers, message) => {
    expect(() => load(peers)).toThrow(message);
  });
});
