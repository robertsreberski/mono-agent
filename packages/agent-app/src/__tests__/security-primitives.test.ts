import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  mergeSecretEnvFile,
  SecretEnvConcurrentModificationError,
  secretEnvConcurrentModificationCause,
} from "../init.js";
import { acquireOwnerPrivateLock } from "../owner-private-lock.js";
import { redactSecrets } from "../redact-secrets.js";
import { secureFileReplace } from "../secure-file-replace.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const incarnation = {
  schema: "mono-agent.process-incarnation.v1" as const,
  bootSessionId: "security-primitives-test-boot",
  processStartId: "security-primitives-test-start",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mono-agent-security-primitives-"));
  roots.push(path);
  return path;
}

async function expectFifoRejectionWithoutBlocking(pending: Promise<unknown>, fifo: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    pending.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ readonly kind: "blocked" }>((resolveBlocked) => {
      timer = setTimeout(() => resolveBlocked({ kind: "blocked" }), 500);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.kind === "blocked") {
    await Promise.allSettled([
      execFileAsync("sh", ["-c", "printf x > \"$1\"", "sh", fifo]),
      pending,
    ]);
  }
  expect(outcome.kind).toBe("rejected");
  if (outcome.kind === "rejected") expect(outcome.error).toBeInstanceOf(Error);
}

describe("shared security primitives", () => {
  it("stages one durable private file before the caller's atomic publication", async () => {
    const dir = await root();
    const path = join(dir, "managed.txt");

    await secureFileReplace({
      path,
      contents: "managed\n",
      mode: 0o600,
      commit: (temporary) => rename(temporary, path),
    });

    expect(await readFile(path, "utf8")).toBe("managed\n");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("never commits or removes a replacement swapped onto the temporary pathname", async () => {
    const dir = await root();
    const path = join(dir, "managed.txt");
    const temporaryPath = join(dir, ".managed.tmp");

    await expect(secureFileReplace({
      path,
      temporaryPath,
      contents: "trusted\n",
      mode: 0o600,
      beforeCommit: async (temporary) => {
        await rename(temporary, `${temporary}.displaced`);
        await writeFile(temporary, "replacement\n", { mode: 0o600 });
      },
      commit: (temporary) => rename(temporary, path),
    })).rejects.toThrow("changed");

    expect(await readFile(temporaryPath, "utf8")).toBe("replacement\n");
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never commits an in-place mutation of the staged inode", async () => {
    const dir = await root();
    const path = join(dir, "managed.txt");
    const temporaryPath = join(dir, ".managed.tmp");

    await expect(secureFileReplace({
      path,
      temporaryPath,
      contents: "trusted\n",
      mode: 0o600,
      beforeCommit: async (temporary) => {
        await writeFile(temporary, "mutated\n", { mode: 0o600 });
      },
      commit: (temporary) => rename(temporary, path),
    })).rejects.toThrow("contents changed");

    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("rejects FIFO swaps without blocking shared file and owner readers", async () => {
    const dir = await root();
    const path = join(dir, "managed.txt");
    const temporaryPath = join(dir, ".managed.tmp");
    const fileReplacement = secureFileReplace({
      path,
      temporaryPath,
      contents: "trusted\n",
      mode: 0o600,
      beforeCommit: async (temporary) => {
        await rename(temporary, `${temporary}.displaced`);
        await execFileAsync("mkfifo", [temporary]);
      },
      commit: (temporary) => rename(temporary, path),
    });
    await expectFifoRejectionWithoutBlocking(fileReplacement, temporaryPath);

    const lockPath = join(dir, "fifo-owner.lock");
    await mkdir(lockPath, { mode: 0o700 });
    const ownerPath = join(lockPath, "owner.json");
    await execFileAsync("mkfifo", [ownerPath]);
    const lockReplacement = acquireOwnerPrivateLock({
      path: lockPath,
      label: "FIFO test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 60_000,
      processIncarnation: incarnation,
    });
    await expectFifoRejectionWithoutBlocking(lockReplacement, ownerPath);
  });

  it("rechecks staged secret bytes immediately before the caller's exclusive publication", async () => {
    const dir = await root();
    const path = join(dir, ".env");
    await writeFile(path, "TOKEN=original\n", { mode: 0o600 });
    await writeFile(
      join(dir, ".gitignore"),
      "/.env\n/..env.mono-agent-*.tmp\n/.env.mono-agent-*.backup\n",
    );

    let failure: unknown;
    try {
      await mergeSecretEnvFile(path, { SECOND: "managed" }, {
        async beforeInstallLink(_target, temporary) {
          await writeFile(temporary, "TOKEN=mutated\n", { mode: 0o600 });
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SecretEnvConcurrentModificationError);
    const recoveryPath = (failure as SecretEnvConcurrentModificationError).recoveryPath;
    expect(recoveryPath).toBeDefined();
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(recoveryPath!, "utf8")).toBe("TOKEN=original\n");
  });

  it("keeps recovery evidence when an async publisher swaps in a same-byte inode", async () => {
    const dir = await root();
    const path = join(dir, ".env");
    await writeFile(path, "TOKEN=original\n", { mode: 0o600 });
    await writeFile(
      join(dir, ".gitignore"),
      "/.env\n/..env.mono-agent-*.tmp\n/.env.mono-agent-*.backup\n",
    );

    let failure: unknown;
    try {
      await mergeSecretEnvFile(path, { SECOND: "managed" }, {
        async beforeInstallLink(_target, temporary) {
          const intended = await readFile(temporary);
          await rename(temporary, `${temporary}.displaced`);
          await writeFile(temporary, intended, { mode: 0o600 });
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as Error).cause).toBeInstanceOf(SecretEnvConcurrentModificationError);
    const cause = secretEnvConcurrentModificationCause(failure)!;
    expect(cause.recoveryPath).toBeDefined();
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(cause.recoveryPath!, "utf8")).toBe("TOKEN=original\n");
  });

  it("serializes a private directory lock and releases only the acquired owner record", async () => {
    const dir = await root();
    const path = join(dir, "operation.lock");
    const options = {
      path,
      label: "Test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 60_000,
      processIncarnation: incarnation,
      isSameProcessIncarnation: async () => true,
      randomToken: () => "test-lock-token",
      ownerFields: () => ({ purpose: "regression" }),
      validateOwnerFields: (record: Readonly<Record<string, unknown>>) => record.purpose === "regression",
    };

    const held = await acquireOwnerPrivateLock(options);
    expect(held?.ownerPid).toBe(process.pid);
    expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toMatchObject({
      schema: "mono-agent.test-lock.v1",
      purpose: "regression",
      pid: process.pid,
    });
    await expect(acquireOwnerPrivateLock(options)).resolves.toBeUndefined();

    await held?.release();
    await held?.release();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite a competing owner published in the mkdir window", async () => {
    const dir = await root();
    const path = join(dir, "publication-race.lock");
    const competitor = `${JSON.stringify({
      schema: "mono-agent.test-lock.v1",
      pid: process.pid,
      token: "competing-owner",
      createdAt: new Date(0).toISOString(),
      incarnation,
    })}\n`;

    const held = await acquireOwnerPrivateLock({
      path,
      label: "Publication-race test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 60_000,
      processIncarnation: incarnation,
      isSameProcessIncarnation: async () => true,
      randomToken: () => "acquiring-owner",
      afterDirectoryCreated: async (lockPath) => {
        await writeFile(join(lockPath, "owner.json"), competitor, { mode: 0o600 });
      },
    });

    expect(held).toBeUndefined();
    expect(await readFile(join(path, "owner.json"), "utf8")).toBe(competitor);
  });

  it("preserves exact lock ownership when Windows cannot fsync a directory handle", async () => {
    const dir = await root();
    const path = join(dir, "windows-operation.lock");
    const unsupported = Object.assign(new Error("directory sync unsupported"), { code: "EINVAL" });
    const held = await acquireOwnerPrivateLock({
      path,
      label: "Windows test lock",
      schemaTag: "mono-agent.test-lock.v1",
      ownerlessGraceMs: 60_000,
      processIncarnation: incarnation,
      platform: "win32",
      syncDirectoryHandle: async () => { throw unsupported; },
    });

    expect(held).toBeDefined();
    expect((await lstat(path)).isDirectory()).toBe(true);
    await held?.release();
  });

  it("uses one bounded redactor for explicit, environment, header, and token-shaped secrets", () => {
    const explicit = "explicit-provider-secret";
    const environmental = "environment-provider-secret";
    const shortEnvironmental = "abc";
    const opaque = "abcdefghijklmnopqrstuvwxyz012345";
    const message = redactSecrets(
      `failed ${explicit} ${environmental} ${shortEnvironmental} Bearer bearer-value api_key=inline-value ${opaque}\nagain`,
      {
        fallback: "provider failed",
        secrets: [explicit],
        environment: { PROVIDER_SECRET: environmental, SHORT_API_KEY: shortEnvironmental },
      },
    );

    expect(message).not.toContain(explicit);
    expect(message).not.toContain(environmental);
    expect(message).not.toContain(shortEnvironmental);
    expect(message).not.toContain("bearer-value");
    expect(message).not.toContain("inline-value");
    expect(message).not.toContain(opaque);
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThanOrEqual(400);
  });

  it("scrubs structured credentials and applies the same safe bound to fallbacks", () => {
    const structured = redactSecrets(
      'https://user:pass@example.test/?token=short-token https://username-token@example.test/ https://user@realm:opaque@host.test/ {"client_secret":"shh","refresh_token":"refresh-value"} Authorization: Basic dXNlcjpwYXNz',
      { fallback: "provider failed" },
    );
    expect(structured).not.toContain("user:pass");
    expect(structured).not.toContain("username-token");
    expect(structured).not.toContain("realm:opaque");
    expect(structured).not.toContain("short-token");
    expect(structured).not.toContain("shh");
    expect(structured).not.toContain("refresh-value");
    expect(structured).not.toContain("dXNlcjpwYXNz");

    const fallback = redactSecrets(" \n ", {
      fallback: `token=fallback-secret ${"word ".repeat(160)}`,
    });
    expect(fallback).not.toContain("fallback-secret");
    expect(fallback.length).toBeLessThanOrEqual(400);
  });

  it("snapshots an Error message once before redaction", () => {
    const error = new Error("unused");
    let reads = 0;
    Object.defineProperty(error, "message", {
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? "stable provider failure" : "unrecognized-secret";
      },
    });

    expect(redactSecrets(error, { fallback: "provider failed" })).toBe("stable provider failure");
    expect(reads).toBe(1);
  });
});
