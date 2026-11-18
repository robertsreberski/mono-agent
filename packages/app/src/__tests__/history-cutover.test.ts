import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { assertNoRetiredMonoAgentConfig, resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { createToolPolicy } from "@mono-agent/conversation";
import { createConfiguredConversationHarness } from "../composition/configured-agent.js";
import { contextSection } from "../doctor/context.js";
import { historySoulReferences } from "../context/history-soul.js";
import { APP_TOOL_NAMES, DEFAULT_SAFE_TOOLS, isKnownToolName } from "../tools/known-tools.js";
import { appOwnedMcpServerSpec, APP_OWNED_MCP_SERVERS } from "../mcp/app-owned-tool-policy.js";
import { historyToolAvailabilityForRuntime } from "../request-tools/history-policy.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "history-cutover-")); roots.push(root); await writeFile(join(root,"IDENTITY.md"),"Fictional fixture."); return root; }
const oldNames = ([
  ["ConversationHistory", "conversation_history", "conversation", "said"],
  ["SessionHistory", "session_history", "session", "tools"],
  ["RunHistory", "run_history", "run", "runs"],
] as const).flatMap(([name, snake, server, scope]) =>
  [name, snake, `mcp__mono-agent-${server}-history__${name}`, `mcp__mono-agent-${server}-history__${snake}`,
    `mcp__mono-agent-${server}-history__*`].map(spelling => ({ spelling, scope })));
it.each(oldNames)("keeps config and conversation retirement consistent: $spelling → $scope", ({ spelling, scope }) => {
  for (const field of ["allowedTools", "disallowedTools"] as const) {
    const policy = { [field]: ["Read", ` ${spelling} `] };
    const diagnostic = `${field}[1] lists removed tool ${spelling}. Replace it with History (scope:"${scope}")`;
    expect(() => assertNoRetiredMonoAgentConfig({ tools: policy })).toThrow(diagnostic);
    expect(() => createToolPolicy(policy)).toThrow(diagnostic);
  }
});
it.each(["History", "ConversationHistoryStore", "mcp__external__RunHistory", "mcp__mono-agent-conversation-history__OtherTool"])(
  "keeps %s outside both retirement lists", name => {
    const policy = { disallowedTools: [name] };
    expect(() => assertNoRetiredMonoAgentConfig({ tools: policy })).not.toThrow();
    expect(() => createToolPolicy(policy)).not.toThrow();
  },
);
it("offers only History and keeps it parent-only with the broader safe default", () => {
  expect(APP_TOOL_NAMES).toContain("History"); expect(DEFAULT_SAFE_TOOLS).toContain("History"); expect(isKnownToolName("History")).toBe(false);
  for (const name of ["ConversationHistory","SessionHistory","RunHistory"]) expect(APP_TOOL_NAMES).not.toContain(name);
  for (const server of ["mono-agent-conversation-history","mono-agent-session-history","mono-agent-run-history"]) expect(APP_OWNED_MCP_SERVERS).not.toHaveProperty(server);
});
it("clones frozen scope metadata without policy aliases and refuses malformed metadata", () => {
  const spec = appOwnedMcpServerSpec("mono-agent-history", {}, {said:true,tools:false,runs:true}) as any;
  expect(Object.isFrozen(spec.appOwnedTools.historyScopes)).toBe(true);
  expect(spec.appOwnedTools.aliases).toEqual({});
  const availability = (descriptor: unknown) => historyToolAvailabilityForRuntime({allowedTools:["*"],mcpServers:{"mono-agent-history":{appOwnedTools:descriptor}}});
  expect(availability(structuredClone(spec.appOwnedTools))).toEqual({said:true,tools:false,runs:true});
  for (const historyScopes of [undefined,{},[],{said:true,tools:false},{said:1,tools:false,runs:true},{said:true,tools:false,runs:true,extra:true}]) expect(availability({...spec.appOwnedTools,historyScopes})).toEqual({said:false,tools:false,runs:false});
});
it("refuses stale soul prose before runtime setup and reports the same file/line in doctor", async () => {
  const root = await fixture(); const soulPath = join(root,"SOUL.md"); await writeFile(soulPath,"Fictional rules.\nConversationHistory was retired.\n");
  const config = resolveJsonMonoAgentConfig({cwd:root,json:{runtime:{model:"openai-codex:gpt-5.5"},context:{identityPath:"IDENTITY.md",soulPath:"SOUL.md"}}});
  const configureTools = vi.fn();
  await expect(createConfiguredConversationHarness({cwd:root,config,env:{},runtime:{configureTools,async run(){throw Error("must not run");}}})).rejects.toThrow(`${soulPath}:2`);
  expect(configureTools).not.toHaveBeenCalled();
  expect(await contextSection(config,root)).toMatchObject({status:"error",details:expect.arrayContaining([expect.stringContaining(`${soulPath}:2`)])});
  await writeFile(soulPath,"ConversationHistoryStore and xConversationHistory are not tool identifiers.\nHistory scope said.");
  expect(await historySoulReferences(soulPath)).toEqual([]);
});
it("warns rather than refuses identity prose", async () => {
  const root = await fixture(); await writeFile(join(root,"IDENTITY.md"),"Fictional identity mentions SessionHistory.");
  const config = resolveJsonMonoAgentConfig({cwd:root,json:{runtime:{model:"openai-codex:gpt-5.5"},context:{identityPath:"IDENTITY.md"}}});
  expect(await contextSection(config,root)).toMatchObject({status:"waiting",details:expect.arrayContaining([expect.stringContaining("Warning:")])});
});

it("uses the context loader diagnostic for a missing soul before runtime setup", async () => {
  const root = await fixture();
  const soulPath = join(root, "missing-soul.md");
  const config = resolveJsonMonoAgentConfig({ cwd: root, json: { runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md", soulPath } } });
  const configureTools = vi.fn();
  await expect(createConfiguredConversationHarness({ cwd: root, config, env: {}, runtime: { configureTools, async run() { throw Error("must not run"); } } }))
    .rejects.toMatchObject({ message: "Unable to read soulPath.", code: "file_read_failed", details: { path: soulPath } });
  expect(configureTools).not.toHaveBeenCalled();
});

it("warns for stale inline prompts and unreadable subagent prompt files", async () => {
  const root = await fixture();
  const promptPath = join(root, "prompt-directory");
  await mkdir(promptPath);
  const config = resolveJsonMonoAgentConfig({ cwd: root, json: { runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" },
    subagents: { definitions: [
      { name: "inline-helper", description: "Fictional helper.", prompt: "First line.\nUse RunHistory for a past run." },
      { name: "file-helper", description: "Another fictional helper.", promptPath },
    ] },
  } });
  expect(await contextSection(config, root)).toMatchObject({ status: "waiting", details: expect.arrayContaining([
    expect.stringContaining("Warning: subagents.definitions[0].prompt:2: removed history tool RunHistory"),
    expect.stringContaining(`Warning: Could not check ${promptPath} for retired history tools`),
  ]) });
});
