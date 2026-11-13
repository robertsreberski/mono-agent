import { expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { MemorySessionRepo } from "../../engine/session-store.js";
import { createRunDriver } from "../../engine/run-driver.js";
vi.mock("node:crypto", async importOriginal => ({ ...await importOriginal<typeof import("node:crypto")>(), randomUUID: vi.fn() }));

it("keeps exact baseline native journal JSON bytes without admission, including seed/owner/cut/rewind", async () => {
  let next = 0;
  vi.mocked(randomUUID).mockImplementation(() => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`);
  const now = vi.spyOn(Date, "now").mockReturnValue(12345);
  const repo = new MemorySessionRepo(), raw = await repo.create({ id: "fiction-handle", cwd: "/fictional" });
  const driver = createRunDriver(raw, { model: { provider: "faux", id: "fixture", api: "faux" }, tools: [] });
  try {
    const seed = await raw.appendMessage({ role: "user", content: "Fictional cold pack without authentication.", timestamp: 1 });
    await driver.beginTurn("fiction-turn", "host", { kind: "host", ownerKey: "fiction", historyBucket: "fiction:bucket", handleId: "fiction-handle", turnId: "fiction-turn", baseRevision: 0 });
    driver.hooks.on("before_compaction", () => ({ compaction: { summary: "Fictional summary.", retainedTail: [], tokensBefore: 1000 } }));
    await driver.compact(); await driver.endTurn("completed"); await raw.moveTo(seed);
    const bytes = JSON.stringify(raw.metadata) + "\n" + raw.records!.map(record => JSON.stringify(record) + "\n").join("");
    // Captured from the exact PR1 renderer/store/driver base, not rebaselined.
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("8efdf63e4721ff664b38dc826bf91765999f571499e21aff3eb86886d003362c");
  } finally { await driver.close(); await raw.close(); now.mockRestore(); }
});
