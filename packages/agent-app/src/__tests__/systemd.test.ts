import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inspectSystemd, readSystemdDefinition, renderSystemdUnit, startSystemd, stopSystemd,
  systemdLogs, systemdUnitName, systemdUnitPath, withSystemdLock,
} from "../systemd.js";
import type { SystemdDefinition, SystemdDeps } from "../systemd.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "mono-systemd-test-"));
  roots.push(homeDir);
  const definition: SystemdDefinition = { identity: "/agent/config.json", cwd: "/agent", argv: ["/usr/bin/node", "/cli.js", "start", "--foreground"], environment: { PATH: "/usr/bin:/bin" } };
  let active = false;
  let enabled = false;
  let loaded = false;
  let time = 0;
  let linger = "yes";
  const calls: string[][] = [];
  const deps: SystemdDeps = { homeDir, now: () => time, sleep: async (ms) => { time += ms; }, stderr: { write: vi.fn() },
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "loginctl") return { code: 0, stdout: linger, stderr: "" };
      if (args[1] === "show") return { code: loaded ? 0 : 1, stdout: [
        `LoadState=${loaded ? "loaded" : "not-found"}`, `ActiveState=${active ? "active" : "inactive"}`,
        `SubState=${active ? "running" : "dead"}`, `MainPID=${active ? 123 : 0}`, "ExecMainStartTimestamp=today",
        `UnitFileState=${enabled ? "enabled" : "disabled"}`, `FragmentPath=${loaded ? systemdUnitPath(definition.identity, { homeDir }) : ""}`,
      ].join("\n"), stderr: "" };
      if (args[1] === "enable") { enabled = true; loaded = true; }
      if (args[1] === "disable") { enabled = false; if (args.includes("--now")) active = false; }
      if (args[1] === "start" || args[1] === "restart") active = true;
      if (args[1] === "stop") active = false;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { definition, deps, calls, setLinger: (value: string) => { linger = value; } };
}

describe("systemd user lifecycle", () => {
  it("derives stable config-qualified units and a separate web unit", () => {
    expect(systemdUnitName("/a/config.json")).toBe(systemdUnitName("/a/config.json"));
    expect(systemdUnitName("/a/config.json")).not.toBe(systemdUnitName("/b/config.json"));
    expect(systemdUnitName("web")).toBe("mono-agent-web.service");
  });

  it("quotes systemd arguments without shell, dollar or specifier expansion", () => {
    const unit = renderSystemdUnit({ identity: "/a", cwd: "/space dir/%h", argv: ["/usr/bin/node", 'a "$HOME" %n \\ z'], environment: { LANG: "en_US.UTF-8" } });
    expect(unit).toContain('WorkingDirectory=/space dir/%%h');
    expect(unit).toContain('ExecStart="/usr/bin/node" "a \\"$$HOME\\" %%n \\\\ z"');
    expect(unit).toContain("StandardOutput=journal");
    expect(unit).not.toContain("launchd");
    expect(() => renderSystemdUnit({ identity: "a", cwd: "/a", argv: ["/node", "\nExecStart=/bad"], environment: {} })).toThrow("control characters");
    expect(() => renderSystemdUnit({ identity: "a", cwd: '/a/"quote"', argv: ["/node"], environment: {} })).toThrow("quotes, backslashes");
    expect(() => renderSystemdUnit({ identity: "a", cwd: "/a/back\\slash", argv: ["/node"], environment: {} })).toThrow("quotes, backslashes");
  });

  it("does not let an abandoned PID-named temporary block publication", async () => {
    const { definition, deps } = await fixture();
    const path = systemdUnitPath(definition.identity, deps);
    await mkdir(join(deps.homeDir!, ".config"), { mode: 0o700 });
    await mkdir(join(deps.homeDir!, ".config", "systemd"), { mode: 0o700 });
    await mkdir(dirname(path), { mode: 0o700 });
    await writeFile(`${path}.${process.pid}.tmp`, "abandoned", { mode: 0o600 });
    await startSystemd(definition, false, async () => true, deps);
    expect(await readSystemdDefinition(definition.identity, deps)).toEqual(definition);
  });

  it("installs, proves readiness, preserves an active start, and removes only its unit", async () => {
    const { definition, deps, calls } = await fixture();
    const ready = vi.fn(async () => true);
    await withSystemdLock(definition.identity, deps, () => startSystemd(definition, false, ready, deps));
    expect(await readSystemdDefinition(definition.identity, deps)).toEqual(definition);
    expect((await inspectSystemd(definition.identity, deps)).pid).toBe(123);
    expect(ready).toHaveBeenCalled();
    const starts = calls.filter((call) => call[2] === "start").length;
    await startSystemd(definition, false, ready, deps);
    expect(calls.filter((call) => call[2] === "start")).toHaveLength(starts);
    await stopSystemd(definition.identity, deps);
    expect(await readSystemdDefinition(definition.identity, deps)).toBeUndefined();
    expect(calls).toContainEqual(["systemctl", "--user", "disable", "--now", systemdUnitName(definition.identity)]);
  });

  it("serializes mutations of the same unit", async () => {
    const { definition, deps } = await fixture();
    await withSystemdLock(definition.identity, deps, async () => {
      await expect(withSystemdLock(definition.identity, deps, async () => undefined)).rejects.toThrow("Another lifecycle");
    });
  });

  it("restores the previous definition and running service after failed restart readiness", async () => {
    const { definition, deps, calls } = await fixture();
    await startSystemd(definition, false, async () => true, deps);
    await expect(startSystemd({ ...definition, argv: [...definition.argv, "--changed"] }, true, async () => false, deps)).rejects.toThrow("did not report ready");
    expect(await readSystemdDefinition(definition.identity, deps)).toEqual(definition);
    expect((await inspectSystemd(definition.identity, deps)).activeState).toBe("active");
    expect(calls).toContainEqual(["systemctl", "--user", "stop", systemdUnitName(definition.identity)]);
  });

  it("cleans up an initial service that never becomes ready", async () => {
    const { definition, deps } = await fixture();
    await expect(startSystemd(definition, false, async () => false, deps)).rejects.toThrow("did not report ready");
    expect(await readSystemdDefinition(definition.identity, deps)).toBeUndefined();
    expect((await inspectSystemd(definition.identity, deps)).pid).toBe(0);
  });

  it("refuses foreign and symlinked unit files without running mutations", async () => {
    const { definition, deps, calls } = await fixture();
    const path = systemdUnitPath(definition.identity, deps);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "[Service]\nExecStart=/unrelated\n", { mode: 0o600 });
    await expect(stopSystemd(definition.identity, deps)).rejects.toThrow("unrecognized");
    expect(calls).toHaveLength(0);
    const foreign = join(deps.homeDir!, "foreign");
    await writeFile(foreign, "untouched");
    await rm(path);
    await symlink(foreign, path);
    await expect(startSystemd(definition, false, async () => true, deps)).rejects.toThrow("unsafe");
    expect(await readFile(foreign, "utf8")).toBe("untouched");
  });

  it("reports user-manager failures instead of treating them as stopped", async () => {
    await expect(inspectSystemd("web", { run: async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }) })).rejects.toThrow("connect to bus");
  });

  it("warns about linger without failing a healthy launch", async () => {
    const { definition, deps, setLinger } = await fixture();
    setLinger("no");
    await startSystemd(definition, false, async () => true, deps);
    expect(deps.stderr!.write).toHaveBeenCalledWith(expect.stringContaining("loginctl enable-linger"));
  });

  it("passes journal options as argv and propagates failures", async () => {
    const journal = vi.fn(async () => 3);
    expect(await systemdLogs("web", true, 42, { journal })).toBe(3);
    expect(journal).toHaveBeenCalledWith(["--user", "--unit", "mono-agent-web.service", "--no-pager", "--lines", "42", "--follow"]);
  });
});
