import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listTraceSources } from "@mono-agent/observability";
import { startWebServer } from "@mono-agent/web";
import type { CredentialSnapshot } from "@mono-agent/channel-operator";
import { startMonoAgentApp } from "../host/app.js";
import { createTuiChannelDriver, createOpenAIApiChannelDriver } from "../channels/channels.js";
import type { MonoAgentAppController } from "../host/app-controller.js";

it("round-trips console credentials to the selected dotenv without exposing planted values in projections, logs or local traces", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "credential-round-trip-")));
  const cleanup: Array<() => Promise<unknown>> = [];
  const plantedValue = ["fictional", "client", "bearer"].join("-");
  const logs: unknown[] = [];
  try {
    const configPath = join(root, "mono-agent.config.json"), dotenvPath = join(root, ".env.custom"), registryDir = join(root, "traces");
    await writeFile(join(root, "IDENTITY.md"), "# Synthetic agent\n");
    await writeFile(configPath, JSON.stringify({ runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, openaiApi: { port: 0 }, traceability: { registryDir, sourceId: "fictional", sourceLabel: "Synthetic" } }));
    const backgroundSnapshot = { schema: "mono-agent.background-snapshot.v1" as const, configPath, configFingerprint: "synthetic-config", dotenvPath, dotenvFingerprint: "synthetic-hmac", identityPath: join(root, "IDENTITY.md"), identityFingerprint: "synthetic-identity", operationalEnvironmentFingerprint: "synthetic-operational" };
    const app = await startMonoAgentApp({ cwd: root, configPath, dotenvPath, env: {}, drivers: [createTuiChannelDriver()], backgroundSnapshot, logger: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args), info: (...args) => logs.push(args) } });
    cleanup.push(() => app.stop());
    expect((app as MonoAgentAppController).dotenvPath).toBe(dotenvPath);
    const web = await startWebServer({ port: 0, stateDir: join(root, "web"), voice: false, discoveryIntervalMs: 0, purgeIntervalMs: 0, logger: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) }, discoverImpl: async () => {
      const { sources } = await listTraceSources({ registryDir });
      const baseUrl = (sources[0]?.metadata?.channels as Record<string, { baseUrl?: string }> | undefined)?.tui?.baseUrl;
      return baseUrl ? [{ source: sources[0]!, baseUrl }] : [];
    } }); cleanup.push(() => web.stop());
    const url = `${web.url}api/v1/agents/fictional/credentials`, headers = { Origin: new URL(web.url).origin, "Content-Type": "application/json" };
    const status = await fetch(url, { headers }); expect(status.status).toBe(200);
    const view = await status.json() as CredentialSnapshot;
    expect(view.cards).toHaveLength(8);
    const save = await fetch(`${url}/save`, { method: "POST", headers, body: JSON.stringify({ card: "openai-api", process: view.process, fence: view.fence, confirmed: true, fields: { bearer: plantedValue } }) });
    expect(save.status).toBe(200); expect(await save.json()).toMatchObject({ outcome: "saved" });
    expect(await readFile(dotenvPath, "utf8")).toContain(plantedValue);
    const refreshed = await (await fetch(url, { headers })).json() as CredentialSnapshot;
    const extraSave = await fetch(`${url}/save`, { method: "POST", headers, body: JSON.stringify({ card: "parallel-search", process: refreshed.process, fence: refreshed.fence, confirmed: true, fields: { credential: plantedValue } }) });
    expect(extraSave.status).toBe(200); expect(await extraSave.json()).toMatchObject({ outcome: "saved" });
    expect((app as MonoAgentAppController).env.PARALLEL_API_KEY).toBeUndefined();
    const operatorUrl = (app as MonoAgentAppController).running.get("tui")!.summary.baseUrl;
    const legacy = await (await fetch(`${operatorUrl}/v1/credentials`)).json() as CredentialSnapshot; expect(legacy.cards.map((card) => card.id)).toEqual(["telegram", "slack", "openai-api"]);
    const extended = await (await fetch(`${operatorUrl}/v1/credentials`, { headers: { "X-Mono-Agent-Credential-Inventory": "extended" } })).json() as CredentialSnapshot; expect(extended.cards).toHaveLength(8);
    const after = await (await fetch(url, { headers })).text(); expect(after).not.toContain(plantedValue);
    expect(await (await fetch(`${web.url}api/v1/agents`)).text()).not.toContain(plantedValue);
    await app.applyConfigChange("synthetic-refresh");
    const { sources } = await listTraceSources({ registryDir });
    expect(sources[0]?.metadata?.backgroundSnapshot).toEqual(backgroundSnapshot);
    expect(JSON.stringify(sources)).not.toContain(plantedValue); expect(JSON.stringify(logs)).not.toContain(plantedValue);
    expect(await readFile(configPath, "utf8")).not.toContain(plantedValue);
    // Disposable next-start activation, with the selected reloadable dotenv (no vendor calls).
    await app.stop();
    const restarted = await startMonoAgentApp({ cwd: root, configPath, dotenvPath, env: parseEnv(await readFile(dotenvPath, "utf8")), drivers: [createOpenAIApiChannelDriver()], logger: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args), info: (...args) => logs.push(args) } });
    cleanup.push(() => restarted.stop());
    expect((restarted as MonoAgentAppController).env.PARALLEL_API_KEY).toBe(plantedValue);
    const endpoint = (restarted as MonoAgentAppController).running.get("openai-api")?.summary.baseUrl;
    expect(typeof endpoint).toBe("string");
    expect((await fetch(`${endpoint}/models`)).status).toBe(401);
    expect((await fetch(`${endpoint}/models`, { headers: { Authorization: "Bearer fictional-wrong-value" } })).status).toBe(401);
    expect((await fetch(`${endpoint}/models`, { headers: { Authorization: `Bearer ${plantedValue}` } })).status).toBe(200);
    expect(JSON.stringify((await listTraceSources({ registryDir })).sources)).not.toContain(plantedValue);
    expect(JSON.stringify(logs)).not.toContain(plantedValue);
  } finally { for (const dispose of cleanup.reverse()) await dispose(); await rm(root, { recursive: true, force: true }); }
}, 90_000);
