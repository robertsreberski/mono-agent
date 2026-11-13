// Test/story display fixture only. Run after building @mono-agent/app.
// The browser never imports app runtime code or maintains a parallel recipe catalog.
import { writeFile } from "node:fs/promises";
import { capabilityCards } from "../dist/setup/capability-status.js";

const statuses = {
  memory: "ok", tools: "ok", mcp: "error", "computer-use": "disabled", observability: "ok", sandbox: "waiting",
  "channel:telegram": "waiting", "channel:slack": "disabled", "channel:webhook": "disabled",
  "channel:openai-api": "disabled", "channel:cron": "disabled",
};
const report = {
  ok: false, structurallyValid: false, operationallyReady: false,
  sections: Object.entries(statuses).map(([id, status]) => ({ id, label: id, status, details: [] })),
};
const snapshot = {
  version: 1, observation: "durable-inputs", observedAt: "2026-08-01T10:00:00Z",
  process: { pid: 42, startedAt: "2026-08-01T09:00:00Z" },
  cards: capabilityCards(report, "lite"),
};
const target = new URL("../../web/webapp/src/test/capability-snapshot.fixture.json", import.meta.url);
await writeFile(target, JSON.stringify(snapshot, null, 2) + "\n");
console.info("Generated synthetic Capabilities display data from the real app catalog.");
