import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  projectCanonicalGraphForAudit,
  resetCanonicalProjectionAuditCacheForTest,
} from "../audit-canonical-projection-cache.js";
import { readCanonicalSourceFingerprint } from "../rebuild.js";

const roots: string[] = [];

afterEach(() => {
  resetCanonicalProjectionAuditCacheForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical audit projection memoization", () => {
  it("reuses an unchanged source fingerprint", () => {
    const root = sourceRoot("Alice");
    const fingerprint = readCanonicalSourceFingerprint(root, "bujo");
    const first = projectCanonicalGraphForAudit(fingerprint, graph(), [memory("Alice is here")]);
    const second = projectCanonicalGraphForAudit(
      readCanonicalSourceFingerprint(root, "bujo"),
      graph(),
      [memory("Alice is here")],
    );

    expect(second).toBe(first);
    expect(second.associations).toHaveLength(1);
  });

  it("invalidates when canonical bytes change without changing record count", () => {
    const root = sourceRoot("Alice");
    const firstFingerprint = readCanonicalSourceFingerprint(root, "bujo");
    const first = projectCanonicalGraphForAudit(firstFingerprint, graph(), [memory("Alice is here")]);

    writeFileSync(join(root, "daily", "2026-01-01.md"), "- Bob__\n", "utf8");
    const changedFingerprint = readCanonicalSourceFingerprint(root, "bujo");
    const changed = projectCanonicalGraphForAudit(changedFingerprint, graph(), [memory("Bob is here")]);

    expect(changedFingerprint).not.toBe(firstFingerprint);
    expect(changed).not.toBe(first);
    expect(first.associations).toHaveLength(1);
    expect(changed.associations).toHaveLength(0);
  });
});

function sourceRoot(text: string): string {
  const root = mkdtempSync(join(tmpdir(), "canonical-audit-cache-"));
  roots.push(root);
  mkdirSync(join(root, "daily"));
  writeFileSync(join(root, "daily", "2026-01-01.md"), `- ${text}\n`, "utf8");
  return root;
}

function graph() {
  return {
    entities: [{ id: "entity:alice", type: "person", name: "Alice", createdAt: "2026-01-01T00:00:00.000Z" }],
    relations: [],
    associations: [],
  } as const;
}

function memory(text: string) {
  return {
    id: "memory-1",
    status: "open" as const,
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
