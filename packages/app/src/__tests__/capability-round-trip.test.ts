import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startTuiAdapter, type CapabilitySetupSnapshot } from "@mono-agent/channel-operator";
import { startWebServer } from "@mono-agent/web";
import { createCapabilityStatusService } from "../setup/capability-status.js";
import { validateMonoAgentFolder } from "../doctor/doctor.js";

it("round-trips a throwaway agent's real doctor status through operator and web, matching liveness-off validate", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capabilities-round-trip-")));
  const configPath = join(root, "mono-agent.config.json");
  await writeFile(join(root, "IDENTITY.md"), "# Fictional Garden Agent\n");
  await writeFile(configPath, JSON.stringify({ agent: { name: "Garden Agent" }, runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, webhook: { enabled: true }, tools: { allowedTools: ["Read"], mcpConfigPath: "missing-mcp.json" } }));
  const before = await readFile(configPath);
  const adapter = await startTuiAdapter({ port: 0, responder: { respond: async () => ({ text: "No model calls in this proof" }) },
    capabilitySetup: createCapabilityStatusService({ cwd: root, configPath, env: process.env }) });
  const web = await startWebServer({ port: 0, stateDir: join(root, "web"), voice: false, discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [{ baseUrl: adapter.baseUrl, source: { schema: "agent-runtime.trace-source.v1", sourceId: "garden-agent", label: "Garden Agent", artifactDir: join(root, "artifacts"), pid: process.pid, status: "running", health: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), warnings: [] } }] }).catch(async (error: unknown) => { await adapter.stop(); await rm(root, { recursive: true, force: true }); throw error; });
  try {
    const response = await fetch(`${web.url}api/v1/agents/garden-agent/capabilities`, { headers: { Origin: new URL(web.url).origin } });
    expect(response.status).toBe(200);
    const shown = await response.json() as CapabilitySetupSnapshot;
    // The same validator as CLI validate, explicitly without network/subprocess
    // liveness probes. The ordinary CLI command intentionally probes more.
    const validated = await validateMonoAgentFolder({ cwd: root, configPath, env: process.env, allowFilesystemWrites: false, liveness: false, subprocessProbes: false });
    expect(shown.cards).toHaveLength(9);
    for (const card of shown.cards) for (const evidence of card.evidence) {
      expect(evidence.status, `${card.id} / ${evidence.id}`).toBe(validated.sections.find((section) => section.id === evidence.id)?.status);
    }
    expect(shown.cards.find((card) => card.id === "tracing")?.status).toBe("ok");
    expect(shown.cards.find((card) => card.id === "tools")?.status).toBe("error");
    expect(await readFile(configPath)).toEqual(before);
    console.info("Capability round-trip: fictional Garden Agent; real liveness-off doctor, operator HTTP and web HTTP; 9 cards matched validate sections; no model call or config write.");
  } finally { await web.stop(); await adapter.stop(); await rm(root, { recursive: true, force: true }); }
}, 90_000);
