import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { cleanupPersistedSandboxSettings } from "../sandbox-settings-cleanup.js";

it("never follows a validly named sandbox directory symlink during persisted cleanup", async () => {
  const target = await mkdtemp(join(tmpdir(), "monitor-cleanup-target-"));
  const alias = join(tmpdir(), `mono-agent-srt-settings-${randomUUID()}`);
  const protectedPath = join(target, "settings.json");
  await chmod(target, 0o700);
  await writeFile(protectedPath, "protected\n", { mode: 0o600 });
  await symlink(target, alias);

  try {
    await expect(cleanupPersistedSandboxSettings(join(alias, "settings.json"))).resolves.toBe(false);
    await expect(readFile(protectedPath, "utf8")).resolves.toBe("protected\n");
  } finally {
    await rm(alias, { force: true });
    await rm(target, { recursive: true, force: true });
  }
});
