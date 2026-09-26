import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { openMemoryDb } from "../../store/index.js";
import { appendBullet, rewriteBullet } from "../daily.js";
import { createBujoMemoryStore } from "../store.js";
import { parseBullet, serializeBullet } from "../grammar.js";
import { encodeMemoryLabel, labelsOf, validateMemoryLabel, withMemoryLabels, type MemoryLabel } from "../labels.js";
import { rebuildFromMarkdown, safeRebuildMemoryIndex } from "../rebuild.js";
import { auditCanonicalGraphParity } from "../graph-parity.js";
import type { Bullet } from "../types.js";
import { fakeEmbeddings } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = mkdtempSync(join(tmpdir(), "memory-labels-")); roots.push(value); return value; }
const when = new Date("2026-07-11T09:00:00.000Z");
function bullet(id: string, text = "Morgan prefers short reports."): Bullet {
  return { id, type: "note", status: "open", text, salience: 0.7,
    isInsight: false, createdAt: when.toISOString(), refs: ["existing-reference"] };
}
const birthday: MemoryLabel = { v: 1, kind: "fact", entityId: "person:morgan", key: "birth_date",
  value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" };
const home: MemoryLabel = { v: 1, kind: "fact", entityId: "person:morgan", key: "home_location",
  value: { type: "text", text: "Northport" }, attribution: "document", validFrom: "2025-01-01", validTo: "2025-12-31" };
const preference: MemoryLabel = { v: 1, kind: "preference", scope: "project:fictional-project", attribution: "user-stated" };
const lesson: MemoryLabel = { v: 1, kind: "lesson", scope: "agent", verified: true };

describe("labels on canonical bullets", () => {
  it("round-trips in refs and remains an ordinary ref to an older reader", () => {
    const labelled = withMemoryLabels(bullet("B1"), [birthday, preference, lesson]);
    const line = serializeBullet(labelled);
    const oldReaderRefs = /refs=(.*?)-->/u.exec(line)?.[1]?.split(",");
    expect(oldReaderRefs).toEqual(labelled.refs); // v0.23 metadata parsing has no label interpretation
    expect(parseBullet(line)).toEqual(labelled);
    expect(labelsOf(parseBullet(line)!)).toEqual([birthday, preference, lesson]);
    expect(serializeBullet(bullet("B1"))).not.toContain("label:");
  });

  it("rejects invalid label syntax and values instead of guessing", () => {
    const valid = bullet("B1");
    for (const ref of ["label:v2:a", "label:v1:!", "label:v1:e30", `${encodeMemoryLabel(birthday)}x`]) {
      expect(() => serializeBullet({ ...valid, refs: [ref] })).toThrow(/invalid label/u);
    }
    expect(parseBullet(serializeBullet(valid).replace("refs=existing-reference",
      "refs=label:v1:bad refs=existing-reference"))?.text).toBe(valid.text);
    expect(() => encodeMemoryLabel({ ...birthday, value: { type: "date", date: "1990-02-30" } })).toThrow();
    expect(() => encodeMemoryLabel({ ...birthday, attribution: "claimed" } as unknown as MemoryLabel)).toThrow();
    expect(() => encodeMemoryLabel({ ...birthday, mystery: true } as unknown as MemoryLabel)).toThrow();
    expect(() => encodeMemoryLabel({ ...preference, scope: "global" })).toThrow();
    expect(() => encodeMemoryLabel({ ...lesson, verified: "yes" } as unknown as MemoryLabel)).toThrow();
  });

  it("round-trips coarse v1 facts, rejects unpaired fields, and reads legacy structured custom facts", () => {
    const coarse: MemoryLabel = { v: 1, kind: "fact", entityId: "person:maple", attribution: "user-stated" };
    const legacy: MemoryLabel = { v: 1, kind: "fact", entityId: "person:maple", key: "other:art-class",
      value: { type: "text", text: "art class" }, attribution: "assistant-inferred" };
    const roundTrip = parseBullet(serializeBullet(withMemoryLabels(bullet("B1", "Maple attends art class."), [coarse, legacy])))!;
    expect(labelsOf(roundTrip)).toEqual([coarse, legacy]);
    for (const invalid of [
      { ...coarse, key: "birth_date" }, { ...coarse, value: { type: "text", text: "art" } },
      { ...coarse, validFrom: "2025-01-01" },
    ]) expect(() => encodeMemoryLabel(invalid as unknown as MemoryLabel)).toThrow();
  });

  it("indexes labels from a daily line and rebuilds scope, history and conflicts", async () => {
    const dir = root();
    const b1 = withMemoryLabels(bullet("B1", "Morgan was born on 1990-05-17."), [birthday, home]);
    const b2 = withMemoryLabels(bullet("B2", "Morgan's date was reported differently."), [
      { ...birthday, value: { type: "date", date: "1991-05-17" } },
      { ...home, value: { type: "text", text: "Southport" }, validFrom: "2026-01-01", validTo: "2026-12-31" },
    ]);
    appendBullet(dir, b1, when);
    appendBullet(dir, b2, when);
    appendBullet(dir, withMemoryLabels(bullet("P1"), [preference, lesson]), when);
    const db = openMemoryDb({ path: join(dir, "memory.db") });
    try {
      await rebuildFromMarkdown(dir, db);
      expect(db.labelsForEntity("person:morgan").filter((hit) => hit.conflict)).toHaveLength(2);
      expect(auditCanonicalGraphParity(dir, db).labels.matched).toBe(6);
      db.replaceMemoryLabels("B1", []);
      expect(auditCanonicalGraphParity(dir, db).labels.missing).toBe(2);
      await rebuildFromMarkdown(dir, db);
      expect(db.labelsForEntity("person:morgan").filter((hit) => hit.label.kind === "fact" && hit.label.key === "home_location")
        .every((hit) => !hit.conflict)).toBe(true);
      expect(db.guidanceForScope("project:fictional-project")[0]?.text).toBe("Morgan prefers short reports.");
      expect(db.guidanceForScope("agent")[0]?.label).toEqual(lesson);
      expect(db.guidanceForScope("conversation:unrelated")).toEqual([]);
      appendBullet(dir, withMemoryLabels(bullet("B3", "Morgan lives in Westport."), [
        { ...home, value: { type: "text", text: "Westport" }, validFrom: "2025-06-01", validTo: "2025-08-31" },
      ]), when);
      await rebuildFromMarkdown(dir, db);
      expect(db.labelsForEntity("person:morgan").filter((hit) => hit.conflict)).toHaveLength(4);
      expect(db.labelsForEntity("person:morgan", "2025-06-01").filter((hit) => hit.currentAt)).toHaveLength(4);
      rewriteBullet(dir, "daily/2026-07-11.md", "B1", { status: "invalidated" });
      await rebuildFromMarkdown(dir, db);
      expect(db.labelsForEntity("person:morgan").filter((hit) => hit.conflict)).toHaveLength(0);
      expect(db.labelsForEntity("person:morgan").filter((hit) => !hit.active)).toHaveLength(2);
      const history = db.listLabels({ kind: "fact", entityId: "person:morgan" });
      expect(history.hits.filter((hit) => hit.status === "invalidated")).toHaveLength(2);
      expect(history.hits[0]?.sourceFile).toContain("daily/");
      expect(history.hits[0]?.sourceLine).toEqual(expect.any(Number));
      expect(db.listLabels({}, 1).truncated).toBe(true);
      expect(db.listLabels({ kind: "lesson", scope: "agent" }).hits).toHaveLength(1);
    } finally { db.close(); }
  });

  it("retains healthy labels beside a malformed ref, supports append/rebuild and forgetting its line", async () => {
    const dir = root();
    const path = join(dir, "daily", "2026-07-11.md");
    appendBullet(dir, withMemoryLabels(bullet("B1"), [birthday, preference]), when);
    writeFileSync(path, readFileSync(path, "utf8").replace(encodeMemoryLabel(preference), "label:v1:bad"));
    const store = createBujoMemoryStore({ root: dir, clock: () => when });
    try {
      await store.remember("fictional-conversation", "Morgan keeps concise notes.");
    } finally { await store.close(); }
    const db = openMemoryDb({ path: join(dir, "rebuild.db") });
    try {
      await rebuildFromMarkdown(dir, db);
      expect(db.labelsForEntity("person:morgan")).toHaveLength(1);
      expect(db.guidanceForScope("project:fictional-project")).toEqual([]);
      expect(auditCanonicalGraphParity(dir, db).issues).toEqual([
        { code: "canonical-read-failed", file: "daily/2026-07-11.md", line: 3 },
      ]);
      expect(rewriteBullet(dir, "daily/2026-07-11.md", "B1", { status: "dropped" })).toBe(true);
      await rebuildFromMarkdown(dir, db);
      expect(db.labelsForEntity("person:morgan")[0]?.active).toBe(false);
      expect(readFileSync(path, "utf8")).not.toContain("label:v1:bad");
      expect(auditCanonicalGraphParity(dir, db).issues).toEqual([]);
    } finally { db.close(); }
  });

  it("stores canonical JSON and commits label row changes to the logical digest", async () => {
    const dir = root();
    const unordered = { kind: "preference", attribution: "user-stated", scope: "agent", v: 1 } as MemoryLabel;
    appendBullet(dir, withMemoryLabels(bullet("B1"), [unordered]), when);
    const path = join(dir, "memory.db");
    const db = openMemoryDb({ path });
    try {
      await rebuildFromMarkdown(dir, db);
      const digest = db.logicalIntegrityDigest();
      db.replaceMemoryLabels("B1", [lesson]);
      expect(db.logicalIntegrityDigest()).not.toBe(digest);
      db.replaceMemoryLabels("B1", [unordered]);
      expect(db.logicalIntegrityDigest()).toBe(digest);
    } finally { db.close(); }
    const raw = new BetterSqlite3(path, { readonly: true });
    try {
      expect((raw.prepare("SELECT payload FROM memory_labels WHERE memory_id = 'B1'").get() as { payload: string }).payload)
        .toBe('{"attribution":"user-stated","kind":"preference","scope":"agent","v":1}');
    } finally { raw.close(); }
  });

  it("sorts mixed Unicode memory ids in SQLite UTF-8 byte order", async () => {
    const dir = root();
    appendBullet(dir, withMemoryLabels(bullet("A\u{10000}"), [preference]), when);
    appendBullet(dir, withMemoryLabels(bullet("A\uE000"), [preference]), when);
    const db = openMemoryDb({ path: join(dir, "memory.db") });
    try {
      await rebuildFromMarkdown(dir, db);
      expect(db.guidanceForScope("project:fictional-project").map((hit) => hit.memoryId))
        .toEqual(["A\uE000", "A\u{10000}"]);
    } finally { db.close(); }
  });

  it("reports malformed canonical labels through BuJo parity audit", async () => {
    const dir = root();
    appendBullet(dir, withMemoryLabels(bullet("B1"), [birthday]), when);
    const db = openMemoryDb({ path: join(dir, "memory.db") });
    try {
      await rebuildFromMarkdown(dir, db);
      const path = join(dir, "daily", "2026-07-11.md");
      writeFileSync(path, readFileSync(path, "utf8").replace(encodeMemoryLabel(birthday), "label:v1:bad"));
      const audit = auditCanonicalGraphParity(dir, db);
      expect(audit.status).toBe("invalid");
      expect(audit.issues).toEqual([{ code: "canonical-read-failed", file: "daily/2026-07-11.md", line: 3 }]);
    } finally { db.close(); }
  });

  it("reads duplicated labelled refs metadata and diagnoses its source line", async () => {
    const dir = root();
    const labelled = withMemoryLabels(bullet("B1"), [birthday]);
    appendBullet(dir, labelled, when);
    const path = join(dir, "daily", "2026-07-11.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("refs=existing-reference,", "refs=existing-reference refs="));
    const db = openMemoryDb({ path: join(dir, "memory.db") });
    try {
      await rebuildFromMarkdown(dir, db);
      expect(db.labelsForEntity("person:morgan")).toHaveLength(1);
      expect(auditCanonicalGraphParity(dir, db).issues).toEqual([
        { code: "canonical-read-failed", file: "daily/2026-07-11.md", line: 3 },
      ]);
    } finally { db.close(); }
  });

  it("safely rebuilds a BuJo source with malformed labels while auditing the line", async () => {
    const dir = root();
    const store = createBujoMemoryStore({ root: dir, tier: "bujo", clock: () => when,
      embeddings: fakeEmbeddings(8), dim: 8,
      llm: { id: "unused", complete: async () => "[]" } });
    try { await store.remember("fictional-conversation", "Morgan keeps concise notes."); }
    finally { await store.close(); }
    const path = join(dir, "daily", "2026-07-11.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("refs=", "refs=label:v1:bad,"));
    const reopened = createBujoMemoryStore({ root: dir, tier: "bujo", clock: () => when,
      embeddings: fakeEmbeddings(8), dim: 8, llm: { id: "unused", complete: async () => "[]" } });
    try { await reopened.remember("fictional-conversation", "Morgan prefers clear notes."); }
    finally { await reopened.close(); }
    const result = await safeRebuildMemoryIndex({ root: dir, tier: "bujo", embeddings: fakeEmbeddings(8), dim: 8 });
    const db = openMemoryDb({ path: result.active, readOnly: true });
    try {
      expect(db.count()).toBe(2);
      expect(db.labelProjection()).toEqual([]);
      expect(auditCanonicalGraphParity(dir, db).issues).toEqual([
        { code: "canonical-read-failed", file: "daily/2026-07-11.md", line: 3 },
      ]);
    } finally { db.close(); }
  });

  it("ignores valid and malformed label refs on Journal rebuild", async () => {
    const dir = root();
    appendBullet(dir, withMemoryLabels(bullet("B1"), [preference]), when);
    appendBullet(dir, bullet("B2", "Morgan prefers short messages."), when);
    const path = join(dir, "daily", "2026-07-11.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("refs=existing-reference", "refs=label:v1:bad"));
    const result = await safeRebuildMemoryIndex({ root: dir, tier: "journal", embeddings: fakeEmbeddings(8), dim: 8 });
    const db = openMemoryDb({ path: result.active, readOnly: true });
    try {
      expect(db.labelProjection()).toEqual([]);
      expect(db.guidanceForScope("project:fictional-project")).toEqual([]);
      expect(auditCanonicalGraphParity(dir, db, { tier: "journal" }).status).toBe("match");
    } finally { db.close(); }
  });

  it("rebuilds a legacy daily file byte-identically and ignores labels outside BuJo", async () => {
    const dir = root();
    mkdirSync(join(dir, "daily"));
    const path = join(dir, "daily", "2026-07-11.md");
    const source = `# 2026-07-11\n\n${serializeBullet(bullet("OLD"))}\n`;
    writeFileSync(path, source);
    const result = await safeRebuildMemoryIndex({ root: dir, tier: "lite" });
    expect(readFileSync(path, "utf8")).toBe(source);
    const db = openMemoryDb({ path: result.active });
    try { expect(db.labelProjection()).toEqual([]); } finally { db.close(); }
    writeFileSync(path, source.replace("refs=existing-reference", "refs=label:v1:bad"));
    const upgraded = await safeRebuildMemoryIndex({ root: dir, tier: "lite" });
    const lite = openMemoryDb({ path: upgraded.active, readOnly: true });
    try { expect(lite.labelProjection()).toEqual([]); } finally { lite.close(); }
    expect(readFileSync(path, "utf8")).toContain("label:v1:bad");
  });
});

describe("legacy relationship refs", () => {
  it("stay readable with any safe lowercase role token and no role list", () => {
    const legacy = (role: string) => ({ v: 1, kind: "fact", entityId: "person:morgan", key: "relationship",
      value: { type: "relationship", role, targetEntityId: "person:maple" }, attribution: "unknown" });
    expect(validateMemoryLabel(legacy("zorbel"))).toEqual(legacy("zorbel"));
    expect(labelsOf({ refs: [encodeMemoryLabel(legacy("quibbet-flarn") as MemoryLabel)] })).toHaveLength(1);
    for (const role of ["Zorbel", "zorbel 2", "-zorbel", "z".repeat(25), ""]) {
      expect(() => validateMemoryLabel(legacy(role))).toThrow(/invalid label/u);
    }
  });
});
