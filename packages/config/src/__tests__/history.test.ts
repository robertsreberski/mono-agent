import { describe, expect, it } from "vitest";
import { assertNoRetiredMonoAgentConfig, resolveJsonMonoAgentConfig } from "../index.js";
import type { MonoAgentConfigJson } from "../index.js";

const resolveConfig = (tools: object) => resolveJsonMonoAgentConfig({ cwd: "/fictional-agent", json: { context: { identityPath: "IDENTITY.md" }, runtime: { model: "openai-codex:gpt-5.5" }, tools } as MonoAgentConfigJson });
const names = ([['ConversationHistory', 'conversation_history', 'conversation', 'said'], ['SessionHistory', 'session_history', 'session', 'tools'], ['RunHistory', 'run_history', 'run', 'runs']] as const)
  .flatMap(([name, snake, server, scope]) => [name, snake, `mcp__mono-agent-${server}-history__${name}`, `mcp__mono-agent-${server}-history__${snake}`, `mcp__mono-agent-${server}-history__*`].map(name => ({ name, scope })));

it.each([{}, { unified: true }, { unified: false }, null, true, [], "yes", { other: true }])("rejects every removed history block %j", history => {
  expect(() => resolveConfig({ history })).toThrow(/tools.history.*removed/);
  expect(() => assertNoRetiredMonoAgentConfig({ tools: { history } })).toThrow(/tools.history.*removed/);
});

describe.each(["allowedTools", "disallowedTools"])("retired %s entries", field => {
  it.each(names)("rejects $name precisely", ({ name, scope }) => {
    expect(() => resolveConfig({ [field]: [name] })).toThrow(`tools.${field}[0] lists removed tool ${name}`);
    for (const config of [
      { tools: { [field]: [name] } },
      { subagents: { [field]: [name] } },
      { subagents: { inline: { [field]: [name] } } },
      { subagents: { definitions: [{ [field]: [name] }] } },
    ]) expect(() => assertNoRetiredMonoAgentConfig(config)).toThrow(`scope:"${scope}"`);
  });
});

it("does not reject unrelated namespaces or unknown tools", () => {
  for (const name of ["UnknownTool", "mcp__other__ConversationHistory", "mcp__other__History", "ConversationHistoryStore"]) {
    expect(() => resolveConfig({ allowedTools: [name] })).not.toThrow();
  }
  expect(resolveConfig({}).tools).not.toHaveProperty("history");
});
