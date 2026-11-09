// Real private files and fd reads; only a deterministic post-stat growth/short-read seam is mocked.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedAuthorization } from "../lib/continuity-guarded-authorization.mjs";
import { ROOT } from "../lib/continuity-observation-input.mjs";
const io = vi.hoisted(() => ({ path: null, grow: false, short: false, bytes: 0, requests: [], closes: 0, wholeReads: 0 }));
const cap = 4 * 1024 * 1024;
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, open: async (...args) => {
    const file = await actual.open(...args);
    if (args[0] !== io.path) return file;
    return {
      stat: async () => {
        const snapshot = await file.stat();
        if (io.grow) await actual.appendFile(io.path, " ".repeat(4 * 1024 * 1024 + 4096));
        return snapshot;
      },
      read: async (buffer, offset, length, position) => {
        io.requests.push({ length, before: io.bytes });
        const result = await file.read(buffer, offset, Math.min(length, io.short ? 8192 : length), position);
        io.bytes += result.bytesRead; return result;
      },
      readFile: async () => { io.wholeReads++; throw Error("whole_inode_read_forbidden"); },
      close: async () => { io.closes++; await file.close(); },
    };
  } };
});
let root;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "guarded-authorization-bounded-")));
  const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
  vi.stubEnv("HOME", home); vi.stubEnv("XDG_STATE_HOME", join(home, "state"));
  vi.stubEnv("CI", undefined); vi.stubEnv("CONTINUITY_DEBUG", undefined);
  Object.assign(io, { path: join(root, "authorization.json"), grow: false, short: false, bytes: 0, requests: [], closes: 0, wholeReads: 0 });
});
afterEach(async () => {
  expect(await readdir(join(root, "home"))).toEqual([]);
  await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});
function validate(id) {
  return guardedAuthorization(id).validate({ authorizationPath: io.path, registrationPath: join(root, "registration.json"), registrationSha256: "a".repeat(64),
    outputRoot: join(root, "output"), credentialPath: join(root, "credential.json"), controllerRoot: ROOT });
}
function bounded() {
  expect(io.wholeReads).toBe(0); expect(io.closes).toBe(1);
  expect(io.bytes).toBeLessThanOrEqual(cap + 1);
  for (const read of io.requests) expect(read.length).toBeLessThanOrEqual(cap + 1 - read.before);
}
for (const [id, prefix] of [["lookup-pilot", "lookup"], ["e2-validation", "e2"]]) {
  it(`${id}: caps a growing inode at maxBytes+1 and preserves the unsafe-file refusal`, async () => {
    await writeFile(io.path, "{}", { mode: 0o600 }); io.grow = true;
    await expect(validate(id)).rejects.toMatchObject({ code: `${prefix}_unsafe_authorization_file` });
    bounded(); expect(io.bytes).toBe(cap + 1);
  });
  it.each([0, cap - 1, cap])(`${id}: handles EOF/short reads at %i bytes without an unsafe-file refusal`, async size => {
    await writeFile(io.path, size ? "{}" + " ".repeat(size - 2) : "", { mode: 0o600 }); io.short = true;
    // These are deliberately invalid authorization objects; byte-safe reads must reach JSON/schema validation.
    await expect(validate(id)).rejects.toMatchObject({ code: `${prefix}_authorization_invalid` });
    bounded(); expect(io.bytes).toBe(size);
  });
}
