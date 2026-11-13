import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startTuiAdapter } from "@mono-agent/channel-operator";
import { describe, expect, it } from "vitest";
import { discoverOperatorAgents } from "../discovery.js";
import { OperatorClient } from "../operator-client.js";
import { temporaryRoot } from "./helpers.js";

describe("one-release operator HTTP compatibility", () => {
  it("admits an old console's bearer at a new agent without treating it as authority", async () => {
    const adapter = await startTuiAdapter({ port: 0, apiKey: "obsolete-inline", responder: { respond: async () => ({ text: "ok" }) } });
    try {
      for (const authorization of [undefined, "Bearer old-console-key", "Bearer obsolete-inline", "Basic obsolete"]) {
        const response = await fetch(adapter.infoUrl, { headers: authorization === undefined ? {} : { authorization } });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ schema: 1, capabilities: { restart: { supported: false } } });
        const turn = await fetch(adapter.turnsUrl, { method: "POST", headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) }, body: JSON.stringify({ conversationId: "web:legacy", text: "hello", client: "web" }) });
        expect(turn.status).toBe(200);
        expect(await turn.text()).toContain("ok");
      }
    } finally { await adapter.stop(); }
  });

  it.each([".env", "agent.production.env"])("connects a new console to an old keyed agent using only the selected %s legacy key", async (dotenvName) => {
    const root = await temporaryRoot();
    const seen: Array<string | undefined> = [];
    // Deliberate old-version wire fixture: unlike current agents, it rejects
    // missing/wrong bearer values. This must be a real HTTP hop, not fetch mocks.
    const oldAgent = createServer((req, res) => {
      seen.push(req.headers.authorization);
      if (req.headers.authorization !== "Bearer legacy-durable") { res.writeHead(401).end(); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ schema: 1, capabilities: {} }));
    });
    await new Promise<void>((resolve) => oldAgent.listen(0, "127.0.0.1", resolve));
    try {
      const address = oldAgent.address();
      if (address === null || typeof address === "string") throw new Error("Missing fixture address");
      const baseUrl = `http://127.0.0.1:${address.port}/gui`;
      expect((await fetch(`${baseUrl}/v1/info`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/v1/info`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      const configPath = join(root, "mono-agent.config.json");
      const dotenvPath = join(root, dotenvName);
      const registry = join(root, "registry");
      await mkdir(registry);
      await writeFile(configPath, JSON.stringify({ tui: { apiKey: "legacy-inline" } }), { mode: 0o600 });
      await writeFile(dotenvPath, "MONO_AGENT_TUI_API_KEY=legacy-durable\nOTHER_SECRET=fictional-unread\nMONO_AGENT_TELEGRAM_BOT_TOKEN=fictional-channel-secret\n", { mode: 0o600 });
      await writeFile(join(registry, "legacy.json"), JSON.stringify({
        schema: "agent-runtime.trace-source.v1", sourceId: "legacy", label: "Legacy fixture",
        artifactDir: join(root, "artifacts"), status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), configPath,
        metadata: { channels: { tui: { kind: "running", baseUrl } }, backgroundSnapshot: {
          schema: "mono-agent.background-snapshot.v1", configPath, configFingerprint: "config-proof", dotenvPath, dotenvFingerprint: "dotenv-proof",
        } },
      }));
      const agents = await discoverOperatorAgents({ registryDirs: [registry], env: { MONO_AGENT_TUI_API_KEY: "legacy-ambient" } });
      expect(agents).toHaveLength(1);
      expect(agents[0]?.apiKey).toBe("legacy-durable");
      expect(JSON.stringify(agents)).not.toMatch(/fictional-unread|fictional-channel-secret|OTHER_SECRET|MONO_AGENT_TELEGRAM_BOT_TOKEN/u);
      expect(process.env.OTHER_SECRET).not.toBe("fictional-unread");
      const client = new OperatorClient({ baseUrl: agents[0]!.baseUrl!, apiKey: agents[0]!.apiKey! });
      expect(await client.info()).toMatchObject({ schema: 1 });
      expect(seen).toEqual([undefined, "Bearer wrong", "Bearer legacy-durable"]);
    } finally {
      await new Promise<void>((resolve, reject) => oldAgent.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(root, { recursive: true, force: true });
    }
  });
});
