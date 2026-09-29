import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fakeEmbeddings } from "./helpers.js";
import { createBujoMemoryStore } from "../store.js";
import { appendGraphBatch } from "../graph.js";
import * as captureOutbox from "../capture-outbox.js";
import { findCanonicalMemoryBullet } from "../canonical-lookup.js";
import { labelsOf, withMemoryLabels } from "../labels.js";
import { appendBullet, normalizedContentHash } from "../daily.js";
import { safeRebuildMemoryIndex } from "../rebuild.js";

const AT = new Date("2026-09-03T10:00:00.000Z");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remember-details-"));
  appendGraphBatch(root, { entities: [{ id: "person:morgan", name: "Morgan", type: "person", createdAt: AT.toISOString() }],
    associations: [] });
  const open = () => createBujoMemoryStore({ root, clock: () => AT, embeddings: fakeEmbeddings(8), dim: 8,
    tier: "bujo", llm: { id: "unused", complete: async () => "[]" } });
  return { root, open };
}

describe("enhanced Remember", () => {
  it("links an existing subject with fixed assistant attribution and durably supersedes ordinary notes", async () => {
    const { root, open } = fixture();
    let store = open();
    const oldText = "Morgan's source note dated 2026-09-02 describes an open question.";
    const newText = "Morgan's source note dated 2026-09-03 confirms the question was answered.";
    try {
      expect(store.supportsRememberDetails()).toBe(true);
      const first = await store.rememberDetails("fictional", oldText, { about: "person:morgan" });
      expect(labelsOf(findCanonicalMemoryBullet(root, first.id, "test")!.bullet)).toEqual([{
        v: 1, kind: "fact", entityId: "person:morgan", attribution: "assistant-inferred",
      }]);
      expect(await store.rememberDetails("fictional", oldText, { about: "person:morgan" }))
        .toMatchObject({ duplicate: true });
      await expect(store.rememberDetails("fictional", oldText, { about: "person:owner" }))
        .rejects.toThrow(/existing person/u);
      await expect(store.rememberDetails("fictional", oldText, { supersedes: first.id }))
        .rejects.toThrow(/itself/u);
      const next = await store.rememberDetails("fictional", newText,
        { about: "person:morgan", supersedes: first.id });
      expect(next.supersededId).toBe(first.id);
      expect(await store.rememberDetails("fictional", newText,
        { about: "person:morgan", supersedes: first.id })).toMatchObject({ duplicate: true, supersededId: first.id });
      expect(findCanonicalMemoryBullet(root, first.id, "test")?.bullet.status).toBe("invalidated");
      const currentHits = (await store.recall("question answered", { topK: 5 })).map((hit) => hit.record.id);
      expect(currentHits).toContain(next.id);
      expect(currentHits).not.toContain(first.id);
      await expect(store.rememberDetails("fictional", "Morgan reported another outcome.", { supersedes: first.id }))
        .rejects.toThrow(/current ordinary note/u);
      await store.close();
      await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: fakeEmbeddings(8), dim: 8 });
      store = open();
      const reopenedHits = (await store.recall("question answered", { topK: 5 })).map((hit) => hit.record.id);
      expect(reopenedHits).toContain(next.id);
      expect(reopenedHits).not.toContain(first.id);
      expect(findCanonicalMemoryBullet(root, next.id, "test")?.bullet.text).toBe(newText);
    } finally { await store.close(); }
  });

  it("does not turn an owner subject into owner-stated authority", async () => {
    const { root, open } = fixture();
    appendGraphBatch(root, { entities: [{ id: "person:owner", name: "Owner", type: "person",
      createdAt: AT.toISOString() }], associations: [] });
    const store = open();
    try {
      const result = await store.rememberDetails("fictional",
        "Assistant noted from Morgan's dated message that the owner postponed a review.",
        { about: "person:owner" });
      expect(labelsOf(findCanonicalMemoryBullet(root, result.id, "test")!.bullet)).toEqual([{
        v: 1, kind: "fact", entityId: "person:owner", attribution: "assistant-inferred",
      }]);
    } finally { await store.close(); }
  });

  it.each(["note", "event"] as const)("supersedes a captured C- %s", async (type) => {
    const { root, open } = fixture();
    const id = `C-${"a".repeat(64)}-00`;
    appendBullet(root, { id, type, status: "open", text: "Morgan's captured update was pending.",
      salience: 0.8, isInsight: false, createdAt: AT.toISOString(), refs: [] }, AT);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: fakeEmbeddings(8), dim: 8 });
    const store = open();
    try {
      const next = await store.rememberDetails("fictional", "Morgan's captured update was completed.",
        { supersedes: id });
      expect(next.supersededId).toBe(id);
      expect(findCanonicalMemoryBullet(root, id, "test")?.bullet.status).toBe("invalidated");
    } finally { await store.close(); }
  });

  it.each(["dropped", "invalidated"] as const)("refuses a %s captured target", async (status) => {
    const { root, open } = fixture();
    const id = `C-${"b".repeat(64)}-00`;
    appendBullet(root, { id, type: "note", status, text: "Morgan's captured update ended.",
      salience: 0.8, isInsight: false, createdAt: AT.toISOString(), refs: [] }, AT);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: fakeEmbeddings(8), dim: 8 });
    const store = open();
    try {
      await expect(store.rememberDetails("fictional", "Morgan proposed another update.", { supersedes: id }))
        .rejects.toThrow(/current ordinary note/u);
    } finally { await store.close(); }
  });

  it("refuses to shadow a root-level legacy daily file", async () => {
    const { root, open } = fixture();
    const store = open();
    try {
      writeFileSync(join(root, "2026-09-03.md"), "# 2026-09-03\n\n- [ ] Legacy dated entry.\n");
      await expect(store.rememberDetails("fictional", "Morgan recorded a fresh fact.", {}))
        .rejects.toThrow(/root-level legacy layout/u);
    } finally { await store.close(); }
  });

  it("rejects duplicate target IDs in their file before publishing an intent", async () => {
    const { root, open } = fixture();
    const bullet = { id: `C-${"c".repeat(64)}-00`, type: "note" as const,
      status: "open" as const, text: "Morgan had an open update.", salience: 0.8,
      isInsight: false, createdAt: AT.toISOString(), refs: [] };
    appendBullet(root, bullet, AT);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: fakeEmbeddings(8), dim: 8 });
    const store = open();
    try {
      appendBullet(root, bullet, AT);
      await expect(store.rememberDetails("fictional", "Morgan had a newer update.", { supersedes: bullet.id }))
        .rejects.toThrow(/duplicate target id/u);
      const outbox = join(root, ".capture-outbox");
      expect(existsSync(outbox) ? readdirSync(outbox).filter((name) => name.startsWith("intent-")) : [])
        .toEqual([]);
    } finally { await store.close(); }
  });

  it("never replaces a text-only Remember fact", async () => {
    const { root, open } = fixture();
    const store = open();
    try {
      const plain = await store.remember("owner-turn", "Morgan prefers tea over coffee.");
      await expect(store.rememberDetails("scan-turn", "Morgan prefers coffee according to a dated message.",
        { supersedes: plain.id })).rejects.toThrow(/only captured notes\/events or enhanced Remember/u);
      expect(findCanonicalMemoryBullet(root, plain.id, "test")?.bullet.status).toBe("open");
    } finally { await store.close(); }
  });

  it("reports a superseded exact text without inviting an impossible retry", async () => {
    const { open } = fixture();
    const store = open();
    try {
      const original = await store.rememberDetails("fictional", "Morgan's state was pending.", {});
      await store.rememberDetails("fictional", "Morgan's state was resolved on 2026-09-03.",
        { supersedes: original.id });
      for (const write of [store.remember("fictional", "Morgan's state was pending."),
        store.rememberDetails("fictional", "Morgan's state was pending.", {})]) {
        await expect(write).rejects.toThrow(/exact text was superseded; record the new state with its date and source/u);
      }
    } finally { await store.close(); }
  });

  it("protects user-stated facts and standing guidance", async () => {
    const { root, open } = fixture();
    for (const [id, label] of [["owner-fact", { v: 1, kind: "fact", entityId: "person:morgan", attribution: "user-stated" }],
      ["standing-preference", { v: 1, kind: "preference", scope: "agent", attribution: "assistant-inferred" }],
      ["standing-lesson", { v: 1, kind: "lesson", scope: "agent", verified: false }]] as const) {
      appendBullet(root, withMemoryLabels({ id, type: "note", status: "open", text: `Morgan's ${id} is historical.`,
        salience: 0.8, isInsight: false, createdAt: AT.toISOString(), refs: [] }, [label]), AT);
    }
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: fakeEmbeddings(8), dim: 8 });
    const store = open();
    try {
      for (const id of ["owner-fact", "standing-preference", "standing-lesson"]) {
        await expect(store.rememberDetails("fictional", `Morgan proposed replacing ${id}.`, { supersedes: id }))
          .rejects.toThrow(/cannot be superseded/u);
        expect(findCanonicalMemoryBullet(root, id, "test")?.bullet.status).toBe("open");
      }
    } finally { await store.close(); }
  });

  it("serializes competing replacements and rejects stale targets", async () => {
    const { open } = fixture();
    const store = open();
    try {
      const first = await store.rememberDetails("fictional", "Morgan's report is pending.", {});
      const attempts = await Promise.allSettled([
        store.rememberDetails("fictional", "Morgan's report is complete.", { supersedes: first.id }),
        store.rememberDetails("fictional", "Morgan's report was withdrawn.", { supersedes: first.id }),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally { await store.close(); }
  });

  it("recovers an intent published before any replay starts", async () => {
    const { root, open } = fixture();
    let store = open();
    const original = await store.rememberDetails("fictional", "Morgan's scan was pending.", {});
    const text = "Morgan's scan finished on 2026-09-03.";
    try {
      const replay = vi.spyOn(captureOutbox, "replayCaptureIntent").mockImplementationOnce(() => {
        throw new Error("fictional crash before replay");
      });
      await expect(store.rememberDetails("fictional", text, { supersedes: original.id }))
        .rejects.toMatchObject({ rememberIntentWritten: true });
      replay.mockRestore();
      expect(findCanonicalMemoryBullet(root, original.id, "test")?.bullet.status).toBe("open");
      await store.close();
      store = open();
      expect(await store.rememberDetails("fictional", text, { supersedes: original.id }))
        .toMatchObject({ duplicate: true, supersededId: original.id });
    } finally { vi.restoreAllMocks(); await store.close(); }
  });

  it("replays a partially committed replacement after reopening without changing its hash or subject", async () => {
    const { root, open } = fixture();
    let store = open();
    const old = await store.rememberDetails("fictional", "Morgan is awaiting confirmation.", {});
    const text = "Morgan confirmed the update on 2026-09-03.";
    try {
      const spy = vi.spyOn(store["db"], "replaceMemoryLabels").mockImplementationOnce(() => {
        throw new Error("fictional projection interruption");
      });
      await expect(store.rememberDetails("fictional", text, { about: "person:morgan", supersedes: old.id }))
        .rejects.toMatchObject({ rememberIntentWritten: true });
      spy.mockRestore();
      await store.close();
      store = open();
      const recovered = await store.rememberDetails("fictional", text,
        { about: "person:morgan", supersedes: old.id });
      expect(recovered).toMatchObject({ id: `RM-${normalizedContentHash(text)}`,
        duplicate: true, supersededId: old.id });
      expect(findCanonicalMemoryBullet(root, old.id, "test")?.bullet.status).toBe("invalidated");
      expect(labelsOf(findCanonicalMemoryBullet(root, recovered.id, "test")!.bullet)).toEqual([{
        v: 1, kind: "fact", entityId: "person:morgan", attribution: "assistant-inferred",
      }]);
    } finally { await store.close(); }
  });

  it("leaves the old note current when embedding preparation fails before mutation", async () => {
    const { root, open } = fixture();
    const seed = open();
    const first = await seed.rememberDetails("fictional", "Morgan is awaiting a response.", {});
    await seed.close();
    const failing = createBujoMemoryStore({ root, clock: () => AT,
      embeddings: { id: "fake-8", embed: async () => { throw new Error("fictional embedding outage"); } }, dim: 8,
      tier: "bujo", llm: { id: "unused", complete: async () => "[]" } });
    try {
      await expect(failing.rememberDetails("fictional", "Morgan received the response.",
        { supersedes: first.id })).rejects.toThrow(/fictional embedding outage/u);
      expect(findCanonicalMemoryBullet(root, first.id, "test")?.bullet.status).toBe("open");
      expect(findCanonicalMemoryBullet(root, `RM-${normalizedContentHash("Morgan received the response.")}`, "test"))
        .toBeUndefined();
    } finally { await failing.close(); }
  });

  it("rejects cancellation before mutation and never publishes a new fact", async () => {
    const { root, open } = fixture();
    const store = open();
    try {
      const abort = new AbortController();
      abort.abort();
      await expect(store.rememberDetails("fictional", "Morgan saw a change.",
        { about: "person:morgan", abortSignal: abort.signal })).rejects.toThrow();
      expect((await store.recall("Morgan saw a change", { topK: 5 })).length).toBe(0);
      expect(findCanonicalMemoryBullet(root, `RM-${normalizedContentHash("Morgan saw a change.")}`, "test"))
        .toBeUndefined();
    } finally { await store.close(); }
  });

  it("rejects unknown subjects, nonexistent targets, self replacement and stale metadata without a write", async () => {
    const { root, open } = fixture();
    const store = open();
    try {
      await expect(store.rememberDetails("fictional", "Morgan had a question.", { about: "person:unknown" }))
        .rejects.toThrow(/existing person/u);
      await expect(store.rememberDetails("fictional", "Morgan had a question.", { supersedes: "absent" }))
        .rejects.toThrow(/unavailable/u);
      const first = await store.rememberDetails("fictional", "Morgan had a question.", { about: "person:morgan" });
      await expect(store.rememberDetails("fictional", "Morgan had a question.", { supersedes: first.id }))
        .rejects.toThrow(/itself/u);
      expect(findCanonicalMemoryBullet(root, first.id, "test")?.bullet.status).toBe("open");
    } finally { await store.close(); }
  });
});
