import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readOwnerJson } from "../durable-root-swap.js";

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readOwnerJson", () => {
  it("reads an unchanged owner-private JSON file", () => {
    const path = ownerJson("valid.json", "{\"ok\":true}\n");

    expect(readOwnerJson(path)).toEqual({ ok: true });
  });

  it("rejects in-place growth between the path stat and opened-handle stat", () => {
    const path = ownerJson("grown.json", "{\"ok\":true}\n");

    expect(() => readOwnerJson(path, {
      afterInitialStat: () => appendFileSync(path, " "),
    })).toThrow(/changed while accessed/u);
  });

  it("validates an in-place oversized opened handle before allocating its size", () => {
    const initial = "{\"ok\":true}\n";
    const path = ownerJson("grown-oversized.json", initial);

    expect(() => readOwnerJson(path, {
      afterInitialStat: () => appendFileSync(
        path,
        Buffer.alloc(MAX_ARTIFACT_BYTES + 1 - Buffer.byteLength(initial), 0x20),
      ),
    })).toThrow(/private artifact is unsafe/u);
  });

  it("rejects an inode swap between the path stat and open", () => {
    const path = ownerJson("swapped.json", "{\"version\":1}\n");
    const original = `${path}.original`;

    expect(() => readOwnerJson(path, {
      afterInitialStat: () => {
        renameSync(path, original);
        writeFileSync(path, "{\"version\":2}\n", { mode: 0o600 });
      },
    })).toThrow(/changed identity/u);
  });

  it("rejects an exact 1,048,577-byte owner-private JSON input", () => {
    const path = ownerJson("oversized.json", Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x20));

    expect(() => readOwnerJson(path)).toThrow(/private artifact is unsafe/u);
  });
});

function ownerJson(name: string, contents: string | Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "memory-owner-json-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}
