import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WebEvent } from "../contracts.js";
import {
  beginWebExternalTurn,
  markWebExternalConversationGone,
  resolveWebExternalProjectDestination,
  syncWebExternalConversations,
} from "../notification-client.js";
import { startWebNotificationIngress } from "../notification-ingress.js";
import { WebService } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function createService(pid = 123): Promise<{ service: WebService; discovered: { pid: number } }> {
  const base = await temporaryRoot();
  cleanup.push(base);
  const discovered = { pid };
  const service = await WebService.create({
    stateDir: join(base, "state"),
    discoveryIntervalMs: 0,
    purgeIntervalMs: 0,
    discoverImpl: async () => [fakeDiscoveredAgent({ source: { ...fakeDiscoveredAgent().source, pid: discovered.pid } })],
    fetchImpl: operatorFetch(),
  });
  return { service, discovered };
}

const FLIGHTS = "telegram:42:-1001:77";
const observation = { key: FLIGHTS, kind: "topic" as const, chatLabel: "Trips", topicLabel: "Flights", seenAt: "2026-09-28T09:00:00.000Z" };

describe("channel conversation ingress", () => {
  it("mirrors observations, serves turn context, and binds tool capabilities to the discovered process", async () => {
    const { service, discovered } = await createService();
    const ingress = await startWebNotificationIngress(service);
    const options = { stateDir: service.store.paths.root };
    const events: WebEvent[] = [];
    const unsubscribe = service.subscribe((event) => { events.push(event); });
    try {
      await expect(syncWebExternalConversations({ sourceId: "agent-one", channel: "telegram", observations: [observation] }, options))
        .resolves.toEqual({ truncated: false });
      const project = service.projects("agent-one")[0]!;
      expect(project).toMatchObject({ name: "Trips › Flights", external: { label: "Trips › Flights" } });
      expect(events.some((event) => event.type === "projects.changed")).toBe(true);
      service.patchProject(project.id, { context: "Prefer aisle seats." });

      // Context is served even when the capability is refused (wrong process).
      const stale = await beginWebExternalTurn({ sourceId: "agent-one", channel: "telegram", pid: 999, turnKey: "telegram-turn-stale", key: FLIGHTS, tools: true }, options);
      expect(stale).toMatchObject({ project: { id: project.id, name: "Trips › Flights", context: "Prefer aisle seats." }, capabilityError: "console_tool_revoked" });
      expect(stale.call).toBeUndefined();

      const turn = await beginWebExternalTurn({ sourceId: "agent-one", channel: "telegram", pid: 123, turnKey: "telegram-turn-live", key: FLIGHTS, tools: true }, options);
      expect(turn.conversation).toMatchObject({ label: "Trips › Flights", state: "open" });
      const listed = await turn.call!({ operationId: randomUUID(), tool: "ListProjects", args: {} });
      expect(listed).toMatchObject({ projects: [{ id: project.id, external: { channel: "telegram", label: "Trips › Flights", state: "open" } }] });
      expect(JSON.stringify(listed)).not.toContain("-1001");
      await expect(turn.call!({ operationId: randomUUID(), tool: "ListTags", args: {} })).rejects.toMatchObject({ code: "console_tool_unavailable" });
      await turn.call!({ operationId: randomUUID(), tool: "UpdateProject", args: { projectId: project.id, context: "Book refundable fares." } });
      expect(service.projects("agent-one")[0]!.context).toBe("Book refundable fares.");

      // Revocation at settlement is final.
      await turn.revoke();
      await expect(turn.call!({ operationId: randomUUID(), tool: "ListProjects", args: {} })).rejects.toMatchObject({ code: "unauthorized" });

      // A restarted agent process (new pid) revokes an outstanding capability.
      const second = await beginWebExternalTurn({ sourceId: "agent-one", channel: "telegram", pid: 123, turnKey: "telegram-turn-second", key: FLIGHTS, tools: true }, options);
      discovered.pid = 456;
      await service.refreshAgents();
      await expect(second.call!({ operationId: randomUUID(), tool: "ListProjects", args: {} })).rejects.toMatchObject({ code: "console_tool_revoked" });

      // Destinations and gone marking are owner-only and never leak other agents.
      await expect(resolveWebExternalProjectDestination({ sourceId: "agent-one", channel: "telegram", projectId: project.id }, options))
        .resolves.toEqual({ key: FLIGHTS, label: "Trips › Flights" });
      await markWebExternalConversationGone({ sourceId: "agent-one", channel: "telegram", key: FLIGHTS }, options);
      expect(service.projects("agent-one")[0]).toMatchObject({ context: "Book refundable fares.", external: { state: "gone" } });
      await expect(resolveWebExternalProjectDestination({ sourceId: "agent-one", channel: "telegram", projectId: project.id }, options))
        .rejects.toMatchObject({ code: "external_conversation_gone" });

      for (const path of ["/internal/v1/external-conversations", "/internal/v1/external-turns", "/internal/v1/external-destinations", "/internal/v1/external-conversations/gone"]) {
        const endpoint = new URL(path, ingress.url);
        expect((await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
        expect((await fetch(endpoint, { method: "POST", headers: { origin: "https://foreign.invalid" }, body: "{}" })).status).toBe(403);
      }
    } finally {
      unsubscribe();
      await ingress.stop();
      await service.stop();
    }
  });

  it("reports the console as unavailable when no ingress is running", async () => {
    const { service } = await createService();
    try {
      await expect(beginWebExternalTurn({ sourceId: "agent-one", channel: "telegram", pid: 123, turnKey: "telegram-turn-down", key: FLIGHTS, tools: false },
        { stateDir: service.store.paths.root })).rejects.toMatchObject({ code: "notification_ingress_unavailable" });
    } finally { await service.stop(); }
  });
});
