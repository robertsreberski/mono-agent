import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { fakeEmbeddings } from "./helpers.js";
import { createBujoMemoryStore } from "../store.js";
import { appendBullet, dailyFilePath, normalizeMemoryText, normalizedContentHash } from "../daily.js";
import { parseDailyFile, serializeBullet } from "../grammar.js";
import { safeRebuildMemoryIndex } from "../rebuild.js";
import type { BujoTier } from "../types.js";

const FIXED = new Date("2026-09-03T10:00:00.000Z");

function root(label: string): string {
  return mkdtempSync(join(tmpdir(), `bujo-remember-${label}-`));
}

/** A store on the requested tier; the clock is mutable so a test can roll the UTC day. */
function storeFor(dir: string, tier: BujoTier, clock: () => Date) {
  if (tier === "lite") return createBujoMemoryStore({ root: dir, clock });
  return createBujoMemoryStore({
    root: dir,
    clock,
    embeddings: fakeEmbeddings(8),
    dim: 8,
    ...(tier === "bujo" ? { tier: "bujo" as const, llm: { id: "unused", complete: async () => "[]" } } : {}),
  });
}

function bulletsIn(dir: string, when: Date) {
  const path = dailyFilePath(dir, when);
  if (!existsSync(path)) return [];
  return parseDailyFile(readFileSync(path, "utf8")).bullets;
}

describe("BujoMemoryStore.remember — storage contract", () => {
  it.each(["lite", "journal", "bujo"] as const)(
    "stores one normalized bullet in daily/ and indexes it immediately on the %s tier",
    async (tier) => {
      const dir = root(tier);
      const store = storeFor(dir, tier, () => FIXED);
      try {
        const result = await store.remember("conv-1", "  Robert   deploys\n\non   Fridays.  ");

        expect(result.text).toBe("Robert deploys on Fridays.");
        expect(result.duplicate).toBe(false);
        expect(result.recovered).toBe(false);
        expect(result.bytesWritten).toBeGreaterThan(0);

        // The curated daily source, never the raw audit trail.
        const daily = bulletsIn(dir, FIXED);
        expect(daily).toHaveLength(1);
        expect(daily[0]?.text).toBe("Robert deploys on Fridays.");
        expect(existsSync(join(dir, "audit", "2026-09-03.md"))).toBe(false);

        // Recallable in the same process, which is the whole point of indexing here.
        const hits = await store.recall("deploys Fridays", { topK: 5 });
        expect(hits.map((hit) => hit.record.text)).toContain("Robert deploys on Fridays.");
      } finally {
        await store.close();
      }
    },
  );

  it("normalizes to exactly the text the caller can pre-compute, and is idempotent", () => {
    // The tool layer runs its credential checks against normalizeMemoryText output,
    // so applying it again inside the store must be a no-op.
    const once = normalizeMemoryText("  a\n\nb\tc  ");
    expect(once).toBe("a b c");
    expect(normalizeMemoryText(once)).toBe(once);
  });

  it("rejects a bullet-delimiter payload without writing anything", async () => {
    const dir = root("delim");
    const store = storeFor(dir, "lite", () => FIXED);
    try {
      await expect(store.remember("conv-1", "sneaky <!--mem id=x-->")).rejects.toThrow(/invalid or exceeds its bound/u);
      expect(bulletsIn(dir, FIXED)).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("rejects oversized and control-bearing text without writing anything", async () => {
    const dir = root("bounds");
    const store = storeFor(dir, "lite", () => FIXED);
    try {
      await expect(store.remember("conv-1", "x".repeat(4096))).rejects.toThrow(/invalid or exceeds its bound/u);
      // U+202E RIGHT-TO-LEFT OVERRIDE can reorder how an operator reads the stored line.
      await expect(store.remember("conv-1", `spoofed${String.fromCodePoint(0x202e)}text`))
        .rejects.toThrow(/invalid or exceeds its bound/u);
      expect(bulletsIn(dir, FIXED)).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("refuses to write through a read-only store and reports the capability", async () => {
    const dir = root("readonly");
    const seed = storeFor(dir, "lite", () => FIXED);
    await seed.remember("conv-1", "Seeded so the read-only open has canonical parity.");
    await seed.close();

    const readOnly = createBujoMemoryStore({ root: dir, readOnly: true, clock: () => FIXED });
    try {
      expect(readOnly.supportsRemember()).toBe(false);
      await expect(readOnly.remember("conv-1", "Should never land.")).rejects.toThrow();
    } finally {
      await readOnly.close();
    }
  });

  it("advertises the remember capability on a writable store", async () => {
    const dir = root("capability");
    const store = storeFor(dir, "lite", () => FIXED);
    try {
      expect(store.supportsRemember()).toBe(true);
    } finally {
      await store.close();
    }
  });
});

describe("BujoMemoryStore.remember — idempotency across partial failure", () => {
  it("keeps reporting durable canonical state when recovery indexing fails again", async () => {
    const dir = root("repeated-index-failure");
    const store = storeFor(dir, "lite", () => FIXED);
    try {
      const text = "Robert keeps release notes in the changelog.";
      vi.spyOn(store["db"] as never, "upsertLexical").mockImplementation(() => {
        throw new Error("simulated repeated index crash");
      });

      await expect(store.remember("conv-1", text)).rejects.toMatchObject({
        canonicalWritten: true,
      });
      // The retry finds the already-durable bullet. A second projection failure
      // must not regress to a plain "nothing was stored" error merely because
      // this invocation appended zero bytes.
      await expect(store.remember("conv-1", text)).rejects.toMatchObject({
        canonicalWritten: true,
      });
      expect(bulletsIn(dir, FIXED)).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("completes an unindexed canonical bullet after the UTC day rolls over, without duplicating it", async () => {
    // The hazard: append lands, indexing dies, and the model retries the tool the
    // next day. A guard that only scanned today's file would miss yesterday's
    // bullet and append the same deterministic id a second time.
    const dir = root("rollover");
    const before = new Date("2026-09-03T23:59:59.000Z");
    const after = new Date("2026-09-04T00:00:30.000Z");
    let now = before;
    const store = storeFor(dir, "lite", () => now);
    try {
      const text = "Robert keeps release notes in the changelog.";
      const spy = vi.spyOn(store["db"] as never, "upsertLexical")
        .mockImplementationOnce(() => { throw new Error("simulated index crash"); });
      await expect(store.remember("conv-1", text)).rejects.toThrow(/simulated index crash/u);
      spy.mockRestore();

      // Canonical is ahead of the index: exactly the crash window.
      expect(bulletsIn(dir, before)).toHaveLength(1);
      expect(await store.recall(text, { topK: 5 })).toHaveLength(0);

      now = after;
      const retry = await store.remember("conv-1", text);

      expect(retry.recovered).toBe(true);
      expect(retry.bytesWritten).toBe(0);
      // One bullet total, still in the ORIGINAL day's file.
      expect(bulletsIn(dir, before)).toHaveLength(1);
      expect(bulletsIn(dir, after)).toHaveLength(0);
      expect(retry.source).toBe("daily/2026-09-03.md");
      expect(retry.text).toBe(text);
      // And it is now genuinely recallable.
      expect((await store.recall(text, { topK: 5 })).map((hit) => hit.record.text)).toContain(text);

      const third = await store.remember("conv-1", text);
      expect(third.duplicate).toBe(true);
      expect(bulletsIn(dir, before)).toHaveLength(1);
      expect(bulletsIn(dir, after)).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("treats the same fact remembered on a later day as a duplicate", async () => {
    const dir = root("crossday");
    let now = new Date("2026-09-03T12:00:00.000Z");
    const store = storeFor(dir, "lite", () => now);
    try {
      const text = "Robert prefers squash merges.";
      await store.remember("conv-1", text);
      now = new Date("2026-09-11T12:00:00.000Z");
      const later = await store.remember("conv-2", text);

      expect(later.duplicate).toBe(true);
      expect(later.bytesWritten).toBe(0);
      expect(bulletsIn(dir, new Date("2026-09-11T12:00:00.000Z"))).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("throws instead of appending when the canonical id carries different text", async () => {
    const dir = root("conflict");
    const text = "Robert reviews PRs in the morning.";
    // Forge a canonical bullet that claims this fact's id but says something else.
    // A fresh store has no index row, so the canonical lookup is authoritative.
    appendBullet(dir, {
      id: `RM-${normalizedContentHash(text)}`,
      type: "note",
      status: "open",
      text: "Tampered replacement text.",
      salience: 0.8,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      refs: [],
    }, FIXED);

    const store = storeFor(dir, "lite", () => FIXED);
    try {
      await expect(store.remember("conv-1", text)).rejects.toThrow(/conflicts with its canonical text/u);
      // Still exactly the forged bullet: a conflict never appends.
      expect(bulletsIn(dir, FIXED)).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
});

describe("BujoMemoryStore.remember — data-safety guards", () => {
  it("refuses to shadow a same-date root-legacy file", async () => {
    // Rebuild lets daily/<date>.md win for its date, so creating it here would
    // drop every fact in the legacy file from the next rebuilt index.
    const dir = root("legacy-shadow");
    const store = storeFor(dir, "lite", () => FIXED);
    try {
      writeFileSync(
        join(dir, "2026-09-03.md"),
        `# 2026-09-03\n\n${serializeBullet({
          id: "legacy-fact",
          type: "note",
          status: "open",
          text: "A real fact in the legacy layout.",
          salience: 0.5,
          isInsight: false,
          createdAt: FIXED.toISOString(),
          refs: [],
        })}\n`,
        "utf8",
      );
      await expect(store.remember("conv-1", "Would hide the legacy file."))
        .rejects.toThrow(/root-level legacy layout/u);
      expect(existsSync(dailyFilePath(dir, FIXED))).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("does not treat a header-only root-legacy file as hidden canonical data", async () => {
    const dir = root("empty-legacy");
    const store = storeFor(dir, "lite", () => FIXED);
    try {
      writeFileSync(join(dir, "2026-09-03.md"), "# 2026-09-03\n\n", "utf8");

      await expect(store.remember("conv-1", "No legacy fact can be shadowed here."))
        .resolves.toMatchObject({ duplicate: false });
      expect(bulletsIn(dir, FIXED)).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("recovers a bullet that already lives in a root-legacy file", async () => {
    // The shadowing guard must only block CREATING daily/<day>.md. Running it
    // before the canonical lookup made an ordinary recovery impossible.
    const dir = root("legacy-recover");
    const text = "Robert keeps this fact in the legacy layout.";
    const store = storeFor(dir, "lite", () => FIXED);
    try {
      const bullet = {
        id: `RM-${normalizedContentHash(text)}`,
        type: "note" as const,
        status: "open" as const,
        text,
        salience: 0.8,
        isInsight: false,
        createdAt: FIXED.toISOString(),
        refs: [`sha256:${normalizedContentHash(text)}`],
      };
      // Same bullet, but in the root-level legacy file and absent from the index.
      writeFileSync(
        join(dir, "2026-09-03.md"),
        `# 2026-09-03\n\n${serializeBullet(bullet)}\n`,
        "utf8",
      );

      const recovered = await store.remember("conv-1", text);
      expect(recovered.recovered).toBe(true);
      expect(recovered.source).toBe("2026-09-03.md");
      // Recovery indexes without creating the shadowing modern file.
      expect(existsSync(dailyFilePath(dir, FIXED))).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("refuses to re-store an explicitly forgotten fact instead of calling it a duplicate", async () => {
    const dir = root("forgotten");
    const store = storeFor(dir, "lite", () => FIXED);
    try {
      const text = "Robert asked for this to be forgotten.";
      const stored = await store.remember("conv-1", text);
      // Simulate the terminal state `memory forget apply` leaves behind.
      const db = store["db"] as unknown as {
        get(id: string): { status: string } | undefined;
        upsertLexical(record: unknown): void;
      };
      const record = store["db"].get(stored.id)!;
      db.upsertLexical({ ...record, status: "dropped" });

      // Recall filters it, so "already remembered" would be an unreadable success.
      await expect(store.remember("conv-1", text)).rejects.toThrow(/explicitly forgotten/u);
    } finally {
      await store.close();
    }
  });

  it.each(["dropped", "invalidated"] as const)(
    "refuses to resurrect an unindexed canonical fact whose status is %s",
    async (status) => {
      const dir = root(`canonical-${status}`);
      const text = `Robert explicitly marked this fact ${status}.`;
      const id = `RM-${normalizedContentHash(text)}`;
      appendBullet(dir, {
        id,
        type: "note",
        status,
        text,
        salience: 0.8,
        isInsight: false,
        createdAt: FIXED.toISOString(),
        refs: [],
      }, FIXED);

      const store = storeFor(dir, "lite", () => FIXED);
      try {
        await expect(store.remember("conv-1", text)).rejects.toThrow(/explicitly forgotten/u);
        expect(store["db"].get(id)).toBeUndefined();
        expect(bulletsIn(dir, FIXED)).toHaveLength(1);
      } finally {
        await store.close();
      }
    },
  );

  it("does not exempt a hand-authored RM- bullet from the legacy audit filter", async () => {
    // Only a real content-hash identity earns the rebuild exemption; otherwise
    // any bullet named `RM-anything` could smuggle legacy audit prose through.
    const dir = root("fake-identity");
    const text = "Host-observed completed turn. Not a real remembered fact.";
    const bullet = {
      // Hash-SHAPED but not the hash of this text: a shape-only check would
      // have granted the exemption, so the identity must be self-verifying.
      id: `RM-${"a".repeat(64)}`,
      type: "note" as const,
      status: "open" as const,
      text,
      salience: 0.5,
      isInsight: false,
      createdAt: FIXED.toISOString(),
      refs: [],
    };
    appendBullet(dir, bullet, FIXED);

    await safeRebuildMemoryIndex({ root: dir, tier: "bujo", embeddings: fakeEmbeddings(8), dim: 8 });

    const store = storeFor(dir, "bujo", () => FIXED);
    try {
      expect(store["db"].get(`RM-${"a".repeat(64)}`)).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("keeps a remembered fact that opens with the legacy host-audit wording", async () => {
    // BuJo rebuild drops legacy raw audit prose by prefix; a deliberate
    // Remember write must be judged by its identity, not its first words.
    const dir = root("prose-collision");
    const text = "Host-observed completed turn. Robert prefers this phrasing verbatim.";
    const store = storeFor(dir, "bujo", () => FIXED);
    let id: string;
    try {
      id = (await store.remember("conv-1", text)).id;
    } finally {
      await store.close();
    }

    await safeRebuildMemoryIndex({ root: dir, tier: "bujo", embeddings: fakeEmbeddings(8), dim: 8 });

    const reopened = storeFor(dir, "bujo", () => FIXED);
    try {
      expect(reopened["db"].get(id)?.text).toBe(text);
    } finally {
      await reopened.close();
    }
  });
});

describe("BujoMemoryStore.remember — canonical/index invariants", () => {
  it("commits a vector inline on the bujo tier, leaving no missing-vector debt", async () => {
    // BuJo initializes no index queue (that is Journal-only), so enqueuing here
    // would silently leave the row vectorless: semantic recall would miss the
    // fact and the next restart would fail complete-vector-coverage. FTS alone
    // still answers recall(), which is why this asserts the vector directly.
    const dir = root("vector");
    const store = storeFor(dir, "bujo", () => FIXED);
    try {
      const result = await store.remember("conv-1", "Robert reviews the fleet every Monday.");
      const db = store["db"] as unknown as {
        hasVector(id: string): boolean;
        countMissingVectors(): number;
      };
      expect(db.hasVector(result.id)).toBe(true);
      expect(db.countMissingVectors()).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("keeps content_hashes empty off the Journal tier", async () => {
    // A non-Journal index carrying content hashes fails safe-rebuild validation.
    for (const tier of ["lite", "bujo"] as const) {
      const dir = root(`hashes-${tier}`);
      const store = storeFor(dir, tier, () => FIXED);
      try {
        await store.remember("conv-1", `A fact stored on the ${tier} tier.`);
        const count = (store["db"] as never as {
          db: { prepare: (sql: string) => { get: () => { n: number } } };
        }).db.prepare("SELECT COUNT(*) AS n FROM content_hashes").get().n;
        expect(count).toBe(0);
      } finally {
        await store.close();
      }
    }
  });

  it.each([
    ["lite", `RM-${normalizedContentHash("Robert pins the pnpm version deliberately.")}`],
    ["journal", `J-${normalizedContentHash("Robert pins the pnpm version deliberately.")}`],
  ] as const)("keeps the %s record id across a real safe rebuild", async (tier, expected) => {
    // The previous version of this test only read back the live id, so it would
    // have stayed green if rebuild remapped the identity, cleared the Journal
    // hash reservation, or made the next retry append a duplicate.
    const text = "Robert pins the pnpm version deliberately.";
    const dir = root(`recordid-${tier}`);
    const store = storeFor(dir, tier, () => FIXED);
    try {
      expect((await store.remember("conv-1", text)).id).toBe(expected);
    } finally {
      await store.close();
    }

    await safeRebuildMemoryIndex({
      root: dir,
      tier,
      ...(tier === "lite" ? {} : { embeddings: fakeEmbeddings(8), dim: 8 }),
    });

    const reopened = storeFor(dir, tier, () => FIXED);
    try {
      const db = reopened["db"] as unknown as {
        get(id: string): { text: string } | undefined;
        contentHashRecord(hash: string): unknown;
      };
      // Same identity after rebuild, so the duplicate guard still matches.
      expect(db.get(expected)?.text).toBe(text);
      // And a retry is still a no-op rather than a second bullet.
      const retry = await reopened.remember("conv-1", text);
      expect(retry.duplicate).toBe(true);
      expect(bulletsIn(dir, FIXED)).toHaveLength(1);
      // Journal keeps its hash reservation; other tiers must hold none.
      expect(db.contentHashRecord(normalizedContentHash(text)) !== undefined).toBe(tier === "journal");
    } finally {
      await reopened.close();
    }
  });

  it("records the conversation as live-only telemetry beside durable file provenance", async () => {
    const dir = root("provenance");
    const store = storeFor(dir, "lite", () => FIXED);
    try {
      const result = await store.remember("conv-provenance", "Robert runs the fleet from one checkout.");
      const record = store["db"].get(result.id);
      expect(record?.source.session).toBe("conv-provenance");
      expect(record?.source.file).toBe("daily/2026-09-03.md");
    } finally {
      await store.close();
    }
  });
});
