import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { canonicalBackgroundConfigPath } from "../service/background/target.js";
import { readOwnerPrivateLaunchdPlist } from "../service/launchd/plist-files.js";
import { ensureTailscaleServe } from "../service/web/tailscale.js";
import type { CommandRunner } from "../service/web/types.js";
import { managedWebPaths } from "../web-maintenance-paths.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-service-guarantee-"));
  roots.push(root);
  return root;
}

it("refuses exact owned Tailscale routes from a different node DNS name without effects", async () => {
  const home = await temporaryRoot();
  const paths = managedWebPaths(home);
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  const webKey = "prior.example.ts.net:8443";
  const tcp = { HTTPS: true };
  const web = { Handlers: { "/": { Proxy: "http://127.0.0.1:5050" } } };
  const ownership = {
    schema: "mono-agent.web-tailscale-serve.v1", webKey, httpsPort: 8443,
    proxyTarget: "http://127.0.0.1:5050",
    configSha256: createHash("sha256").update(JSON.stringify({ tcp, web })).digest("hex"),
    url: "https://prior.example.ts.net:8443/", configuredAt: "2025-01-01T00:00:00.000Z",
  };
  const contents = `${JSON.stringify(ownership)}\n`;
  await writeFile(paths.tailscalePath, contents, { mode: 0o600 });
  const runner = vi.fn<CommandRunner>(async () => ({
    code: 0, stderr: "", stdout: JSON.stringify({ TCP: { "8443": tcp }, Web: { [webKey]: web } }),
  }));
  await expect(ensureTailscaleServe(paths, "127.0.0.1", 5050, {}, { tailscale: runner }, "prior.example.ts.net"))
    .resolves.toEqual({ kind: "active", ownership, reused: true });
  runner.mockClear();
  const before = await lstat(paths.tailscalePath);
  await expect(ensureTailscaleServe(paths, "127.0.0.1", 5050, {}, { tailscale: runner }, "current.example.ts.net"))
    .resolves.toEqual({
      kind: "unavailable",
      detail: "the owned Tailscale handler hostname does not match this node's exact DNS name; refusing to reuse or replace it",
      routeOutcome: "none",
    });
  expect(runner.mock.calls).toEqual([[["serve", "status", "--json"]]]);
  expect(await readFile(paths.tailscalePath, "utf8")).toBe(contents);
  const after = await lstat(paths.tailscalePath);
  expect([after.ino, after.mode, after.mtimeMs, after.ctimeMs])
    .toEqual([before.ino, before.mode, before.mtimeMs, before.ctimeMs]);
});

it("refuses a LaunchAgent plist unless its initial mode is exactly 0600", async () => {
  const root = await temporaryRoot();
  const path = join(root, "fixture.plist");
  await writeFile(path, "<plist>fixture</plist>\n", { mode: 0o600 });
  await expect(readOwnerPrivateLaunchdPlist(path)).resolves.toMatchObject({ contents: "<plist>fixture</plist>\n" });
  // 0400 is still owner-only, so this pins exact 0600 rather than group/world exclusion.
  await chmod(path, 0o400);
  await expect(readOwnerPrivateLaunchdPlist(path)).rejects.toThrow(`LaunchAgent plist ${path} must be owner-only.`);
  expect((await lstat(path)).mode & 0o777).toBe(0o400);
});

it("canonicalizes parent aliases but preserves the final config symlink for start-time refusal", async () => {
  const root = await temporaryRoot();
  const realDirectory = join(root, "real");
  const parentAlias = join(root, "alias");
  await mkdir(realDirectory);
  await symlink(realDirectory, parentAlias, "dir");
  const target = join(realDirectory, "actual.json");
  await writeFile(target, "{}\n");
  const link = join(realDirectory, "mono-agent.config.json");
  await symlink(target, link);
  const canonicalParent = await realpath(realDirectory);
  await expect(canonicalBackgroundConfigPath(parentAlias, "actual.json")).resolves.toBe(await realpath(target));
  const preserved = await canonicalBackgroundConfigPath(parentAlias);
  expect(preserved).toBe(join(canonicalParent, "mono-agent.config.json"));
  expect(preserved).not.toBe(await realpath(target));
  expect((await lstat(preserved)).isSymbolicLink()).toBe(true);
});
