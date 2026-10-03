import { execFile } from "node:child_process";
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getOrCreatePiInstallationId } from "../pi-installation-id.js";

const dirs: string[] = [];
const run = promisify(execFile);
async function store(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-installation-test-"));
  dirs.push(dir);
  return join(dir, "auth.json");
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe.skipIf(process.platform === "win32")("ChatGPT installation identity", () => {
  it("publishes once and survives parallel processes and restarts", async () => {
    const auth = await store();
    const moduleUrl = new URL("../../dist/pi-installation-id.js", import.meta.url).href;
    const script = `import { getOrCreatePiInstallationId } from ${JSON.stringify(moduleUrl)}; process.stdout.write(await getOrCreatePiInstallationId(process.argv[1]));`;
    const values = await Promise.all(Array.from({ length: 6 }, async () =>
      (await run(process.execPath, ["--input-type=module", "-e", script, auth])).stdout));
    expect(new Set(values).size).toBe(1);
    expect(await getOrCreatePiInstallationId(auth)).toBe(values[0]);
    const path = join(join(auth, ".."), "mono-agent-installation-id.json");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schema: "mono-agent.pi-installation-id.v1", id: values[0] });
  });

  it("accepts a crash-after-link winner with two links and an EEXIST contender", async () => {
    const auth = await store();
    const id = "3e53b686-a244-45b6-8267-4dd9e6dce936";
    const path = join(auth, "..", "mono-agent-installation-id.json");
    const temp = join(auth, "..", ".installation-id-crashed.tmp");
    await writeFile(temp, JSON.stringify({ schema: "mono-agent.pi-installation-id.v1", id }), { mode: 0o600 });
    await link(temp, path);
    expect((await lstat(path)).nlink).toBe(2);
    expect(await Promise.all([getOrCreatePiInstallationId(auth), getOrCreatePiInstallationId(auth)])).toEqual([id, id]);
  });

  it("fails closed on malformed or symlinked identity instead of rotating", async () => {
    const auth = await store();
    const path = join(auth, "..", "mono-agent-installation-id.json");
    await writeFile(path, "not-json", { mode: 0o600 });
    await expect(getOrCreatePiInstallationId(auth)).rejects.toMatchObject({ code: "installation_id_invalid", message: expect.stringContaining("file is invalid") });
    await rm(path);
    const victim = join(auth, "..", "victim.json");
    await writeFile(victim, "not-json", { mode: 0o600 });
    await symlink(victim, path);
    await expect(getOrCreatePiInstallationId(auth)).rejects.toThrow();
    expect(await readFile(victim, "utf8")).toBe("not-json");
  });

  it("preserves the safe reason for refusing an identity inside a Git worktree", async () => {
    const auth = await store();
    await run("git", ["init", "-q", join(auth, "..")]);
    await expect(getOrCreatePiInstallationId(auth)).rejects.toMatchObject({
      code: "installation_id_invalid", message: expect.stringContaining("inside a Git worktree"),
    });
  });
});
