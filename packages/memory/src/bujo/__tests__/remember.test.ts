import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { fakeEmbeddings } from "./helpers.js";
import { createBujoMemoryStore } from "../store.js";
import { appendBullet, dailyFilePath, normalizeMemoryText, normalizedContentHash } from "../daily.js";
import { parseDailyFile } from "../grammar.js";
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

describe("BujoMemoryStore.remember — canonical/index invariants", () => {
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

  it("uses the tier-correct record id so the guard survives a rebuild", async () => {
    const text = "Robert pins the pnpm version deliberately.";
    const hash = normalizedContentHash(text);
    for (const [tier, expected] of [["lite", `RM-${hash}`], ["journal", `J-${hash}`]] as const) {
      const dir = root(`recordid-${tier}`);
      const store = storeFor(dir, tier, () => FIXED);
      try {
        const result = await store.remember("conv-1", text);
        expect(result.id).toBe(expected);
      } finally {
        await store.close();
      }
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
