import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { conversationStatePurgePlanEntries, resolveConversationStatePurgePlan } from "../conversation-state-roots.js";
import { purgeConversationState } from "../sessions.js";

describe("subagent instance purge roots", () => {
  it("attests and purges the configured root with all conversations, even when instances are disabled", async () => {
    const root = await mkdtemp(resolve(process.cwd(), ".subagent-purge-"));
    try {
      const childRoot = resolve(root, "children");
      await mkdir(resolve(childRoot, "conversation", "sessions"), { recursive: true });
      await writeFile(resolve(childRoot, "conversation", "instances.json"), "[]");
      const configPath = resolve(root, "mono-agent.config.json");
      await writeFile(configPath, JSON.stringify({ subagents: { enabled: false, instances: { root: "./children" } } }));
      const input = { cwd: root, env: {}, configPath };
      const plan = await resolveConversationStatePurgePlan(input);
      expect(conversationStatePurgePlanEntries(plan)).toContainEqual(expect.objectContaining({ kind: "persistent subagent instances", path: childRoot }));
      await purgeConversationState(input);
      await expect(stat(childRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const envPlan = await resolveConversationStatePurgePlan({ ...input, env: { MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({ instances: { root: "./override" } }) } });
      expect(envPlan.subagents?.path).toBe(resolve(root, "override"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
