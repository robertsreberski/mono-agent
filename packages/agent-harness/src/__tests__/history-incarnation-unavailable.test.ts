import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDurableHistoryStore } from "../durable-history.js";
import { currentProcessIncarnation, PROCESS_INCARNATION_SCHEMA } from "../process-incarnation.js";
import { currentHistoryProcessIncarnation, historyOwnerLiveness } from "../history-process-liveness.js";

vi.mock("../process-incarnation.js", async (original) => ({
  ...await original<typeof import("../process-incarnation.js")>(),
  currentProcessIncarnation: vi.fn(async () => { throw Object.assign(new Error("Fictional unavailable OS identity"), { code: "EACCES" }); }),
}));
it("unavailable self identity is captured once, emits PID-only evidence and never steals a live PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-identity-unavailable-"));
  try {
    const store = createDurableHistoryStore({ root }), owner = await store.beginProviderSessionPreparation("fictional-owner", "fictional-turn");
    try {
      const names = await readdir(join(root, ".locks")), markers = names.filter((name) => name.endsWith(".active")); expect(markers).toHaveLength(1);
      const marker = JSON.parse(await readFile(join(root, ".locks", markers[0]!), "utf8")); expect(marker.incarnation).toBeUndefined();
      for (const name of names.filter((name) => name.startsWith("logical-session-shard-") && name.endsWith(".sqlite"))) {
        const db = new DatabaseSync(join(root, ".locks", name));
        try { if (db.prepare("SELECT name FROM sqlite_master WHERE name='session_claims'").get()) {
          for (const row of db.prepare("SELECT incarnation FROM session_claims").all()) expect(row.incarnation).toBeNull();
        } } finally { db.close(); }
      }
      expect(await currentHistoryProcessIncarnation()).toBeUndefined();
      expect(await historyOwnerLiveness()(process.pid, { schema: PROCESS_INCARNATION_SCHEMA, bootSessionId: "fictional-boot", processStartId: "fictional-start" })).toBe(true);
      expect(currentProcessIncarnation).toHaveBeenCalledTimes(1);
      await store.stats();
    } finally { await owner.abort(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
