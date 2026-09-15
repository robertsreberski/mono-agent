import { describe, expect, it } from "vitest";

import { buildWebLaunchdProgramArguments, WEB_LAUNCHD_LABEL } from "../launchd.js";
import { decodeManagedWebDefinition } from "../web-service-definition.js";

/** The macOS LaunchAgent prefix: env -i … <node> <cli> */
const launchdPrefix = ["/usr/bin/env", "-i", "PATH=/usr/bin", "/managed/node", "/managed/dist/cli.js"];
/** The Linux systemd unit prefix: env -i … <node> -- <cli> */
const systemdPrefix = ["/usr/bin/env", "-i", "PATH=/usr/bin", "/managed/node", "--", "/managed/dist/cli.js"];

describe("managed web definition decoding", () => {
  it("decodes the generated macOS and Linux invocations", () => {
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5050", "--theme", "plum"]))
      .toEqual({ host: "0.0.0.0", port: 5050, theme: "plum" });
    expect(decodeManagedWebDefinition([...systemdPrefix, "web", "run", "--host", "127.0.0.1", "--port", "6060", "--theme", "ocean", "--name", "Flockbox"]))
      .toEqual({ host: "127.0.0.1", port: 6060, theme: "ocean", name: "Flockbox" });
  });

  it("preserves the deliberate legacy omissions", () => {
    // A pre-theme macOS definition: evergreen, no name.
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5050"]))
      .toEqual({ host: "0.0.0.0", port: 5050, theme: "evergreen" });
    // A definition written while the worker's own default was the wide bind.
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--port", "5050", "--theme", "plum"]))
      .toEqual({ host: "0.0.0.0", port: 5050, theme: "plum" });
  });

  it("rejects argv that is not the recognized managed web invocation", () => {
    expect(decodeManagedWebDefinition([])).toBeUndefined();
    expect(decodeManagedWebDefinition(["/bin/echo", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "start", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum", "--theme", "ocean"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum", "--unknown", "1"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition(["web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum"]))
      .toBeUndefined();
  });

  it("rejects missing, duplicated, or invalid option values", () => {
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "not-a-number", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "0", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "65536", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "magenta"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum", "--name", ""]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "", "--port", "5051", "--theme", "plum"]))
      .toBeUndefined();
    expect(decodeManagedWebDefinition([...launchdPrefix, "web", "run", "--host", "0.0.0.0", "--port", "5051", "--theme", "plum", "--name"]))
      .toBeUndefined();
  });

  it("rejects an unrelated command that merely contains the marker tokens", () => {
    // A token immediately before `web` is not a recognized launcher+entrypoint.
    expect(decodeManagedWebDefinition(["/bin/echo", "web", "run", "--port", "5050"])).toBeUndefined();
    expect(decodeManagedWebDefinition(["/bin/sh", "-c", "web run --port 5050"])).toBeUndefined();
    expect(decodeManagedWebDefinition(["/usr/bin/env", "-i", "web", "run", "--port", "5050"])).toBeUndefined();
    expect(decodeManagedWebDefinition(["/usr/bin/env", "-i", "/bin/echo", "web", "run", "--port", "5050"])).toBeUndefined();
    expect(decodeManagedWebDefinition(["/usr/bin/env", "-i", "/managed/node", "/managed/dist/cli.js", "start", "--host", "0.0.0.0", "--port", "5050"])).toBeUndefined();
    expect(decodeManagedWebDefinition(["/usr/bin/env", "-i", "/managed/node", "/managed/dist/cli.js", "web", "run", "--port", "5050", "web"])).toBeUndefined();
  });

  it("decodes builder-produced argv and treats option values as data", () => {
    const builderArgv = buildWebLaunchdProgramArguments({
      label: WEB_LAUNCHD_LABEL,
      nodePath: "/mounted/runtimes/node-24/bin/node",
      cliPath: "/mounted/cli/dist/cli.js",
      cwd: "/tmp/web-state",
      host: "127.0.0.1",
      port: 5051,
      theme: "ocean",
      name: "web",
      stdoutPath: "/tmp/web.out.log",
      stderrPath: "/tmp/web.err.log",
      environment: { PATH: "/usr/bin", MONO_AGENT_WEB_ALLOWED_HOSTS: "console.home.arpa" },
    });
    expect(decodeManagedWebDefinition(builderArgv)).toEqual({
      host: "127.0.0.1",
      port: 5051,
      theme: "ocean",
      name: "web",
    });

    // Command-like labels are data, not invocation markers.
    for (const label of ["run", "--host", "web"]) {
      const argv = buildWebLaunchdProgramArguments({
        label: WEB_LAUNCHD_LABEL,
        nodePath: "/managed/node",
        cliPath: "/managed/dist/cli.js",
        cwd: "/tmp/web-state",
        host: "127.0.0.1",
        port: 5050,
        theme: "plum",
        name: label,
        stdoutPath: "/tmp/web.out.log",
        stderrPath: "/tmp/web.err.log",
        environment: {},
      });
      expect(decodeManagedWebDefinition(argv)).toMatchObject({ name: label });
    }

    // The Linux builder layout: env assignments before node, then the `--`
    // separator, then the CLI entrypoint.
    const linuxArgv = [
      "/usr/bin/env", "-i", "PATH=/usr/bin", "MONO_AGENT_WEB_ALLOWED_HOSTS=console.home.arpa",
      "/usr/bin/node", "--", "/managed/dist/cli.js",
      "web", "run", "--host", "127.0.0.1", "--port", "5050", "--theme", "plum",
    ];
    expect(decodeManagedWebDefinition(linuxArgv)).toEqual({ host: "127.0.0.1", port: 5050, theme: "plum" });
  });
});
