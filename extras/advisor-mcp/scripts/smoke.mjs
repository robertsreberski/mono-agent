import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  loadAdvisorConfig,
  REVIEW_ITERATION_TOOL_NAME,
  startAdvisorServer,
} from "../dist/index.js";

const token = "advisor-loopback-smoke-token";
const config = await loadAdvisorConfig({
  env: {
    MONO_AGENT_ADVISOR_ENABLED: "true",
    MONO_AGENT_ADVISOR_HOST: "127.0.0.1",
    MONO_AGENT_ADVISOR_PORT: "0",
    MONO_AGENT_ADVISOR_REQUIRE_BEARER: "true",
    MONO_AGENT_ADVISOR_BEARER_TOKEN: token,
    MONO_AGENT_ADVISOR_MODEL: "pi:openai-codex:gpt-5.6-sol",
    MONO_AGENT_ADVISOR_EFFORT: "max",
    MONO_AGENT_ADVISOR_NAMESPACE: "loopback-smoke",
  },
  json: {},
});

let starts = 0;
const server = await startAdvisorServer({
  config,
  runFactory: {
    async start(input) {
      starts += 1;
      assert.equal(input.model, config.model);
      assert.equal(input.effort, config.effort);
      return {
        result: Promise.resolve({ text: `Smoke review ${starts}.` }),
        async stop() {},
        async drain() {},
      };
    },
  },
});
const client = new Client({ name: "advisor-loopback-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(server.url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [REVIEW_ITERATION_TOOL_NAME]);
  const input = {
    session_key: "stable-smoke-review",
    intent: "Prove the built Streamable HTTP MCP path.",
    patch: "diff --git a/smoke.ts b/smoke.ts",
    verification: "Built package client/server loopback round trip.",
  };
  const first = await client.callTool({ name: REVIEW_ITERATION_TOOL_NAME, arguments: input });
  const second = await client.callTool({ name: REVIEW_ITERATION_TOOL_NAME, arguments: input });
  assert.equal(first.isError, undefined);
  assert.equal(second.isError, undefined);
  assert.equal(first.structuredContent?.code, "ok");
  assert.equal(second.structuredContent?.code, "ok");
  assert.equal(first.structuredContent?.continuity_id, second.structuredContent?.continuity_id);
  assert.equal(first.structuredContent?.model, config.model);
  assert.equal(first.structuredContent?.effort, config.effort);
  assert.equal(starts, 2);
  process.stdout.write(`${JSON.stringify({
    status: "succeeded",
    transport: "streamable-http-loopback",
    stateless: true,
    tool: REVIEW_ITERATION_TOOL_NAME,
    calls: starts,
    continuityStable: true,
    model: config.model,
    effort: config.effort,
  })}\n`);
} finally {
  await client.close().catch(() => undefined);
  await server.stop();
}
