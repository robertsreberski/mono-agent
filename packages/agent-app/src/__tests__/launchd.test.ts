import { userInfo } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPlistXml,
  defaultPathEnv,
  deriveLaunchdLabel,
  domainTarget,
  escapeXml,
  launchdPathsFor,
  parseLaunchdServicePid,
  serviceTarget,
} from "../launchd.js";
import type { PlistInput } from "../launchd.js";

function plistInput(overrides: Partial<PlistInput> = {}): PlistInput {
  return {
    label: "com.mono-agent.demo-0a1b2c3d",
    nodePath: "/usr/local/bin/node",
    cliPath: "/opt/app/dist/cli.js",
    configPath: "/work/demo/mono-agent.config.json",
    cwd: "/work/demo",
    expectedBackgroundSnapshot: "approved-background-snapshot",
    stdoutPath: "/home/u/.mono-agent/logs/com.mono-agent.demo-0a1b2c3d.out.log",
    stderrPath: "/home/u/.mono-agent/logs/com.mono-agent.demo-0a1b2c3d.err.log",
    environment: { PATH: "/usr/bin:/bin" },
    ...overrides,
  };
}

describe("deriveLaunchdLabel", () => {
  it("is deterministic for the same resolved config path", () => {
    const a = deriveLaunchdLabel("/work/demo/mono-agent.config.json");
    const b = deriveLaunchdLabel("/work/demo/mono-agent.config.json");
    expect(a).toBe(b);
  });

  it("differs for different config paths and only uses launchd-legal chars", () => {
    const a = deriveLaunchdLabel("/work/demo/mono-agent.config.json");
    const b = deriveLaunchdLabel("/work/other/mono-agent.config.json");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^com\.mono-agent\.[a-z0-9-]+-[0-9a-f]{8}$/u);
    expect(b).toMatch(/^com\.mono-agent\.[a-z0-9-]+-[0-9a-f]{8}$/u);
  });

  it("sanitizes folder names with spaces, symbols, and casing", () => {
    const label = deriveLaunchdLabel("/work/My Agent & Co!/mono-agent.config.json");
    expect(label).toMatch(/^com\.mono-agent\.my-agent-co-[0-9a-f]{8}$/u);
  });

  it("falls back to 'agent' when the folder sanitizes to empty", () => {
    const label = deriveLaunchdLabel("/&&&/mono-agent.config.json");
    expect(label).toMatch(/^com\.mono-agent\.agent-[0-9a-f]{8}$/u);
  });
});

describe("launchdPathsFor", () => {
  it("places the plist and logs under the home directory", () => {
    const paths = launchdPathsFor("com.mono-agent.demo-0a1b2c3d", "/home/u");
    expect(paths.plistPath).toBe("/home/u/Library/LaunchAgents/com.mono-agent.demo-0a1b2c3d.plist");
    expect(paths.stdoutPath).toBe("/home/u/.mono-agent/logs/com.mono-agent.demo-0a1b2c3d.out.log");
    expect(paths.stderrPath).toBe("/home/u/.mono-agent/logs/com.mono-agent.demo-0a1b2c3d.err.log");
    expect(paths.launchAgentsDir).toBe("/home/u/Library/LaunchAgents");
    expect(paths.logDir).toBe("/home/u/.mono-agent/logs");
  });

  it("uses the OS account home instead of an ambient HOME override", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/untrusted-mono-agent-home";
    try {
      const paths = launchdPathsFor("com.mono-agent.demo-0a1b2c3d");
      const accountHome = userInfo().homedir;
      expect(paths.launchAgentsDir).toBe(resolve(accountHome, "Library", "LaunchAgents"));
      expect(paths.logDir).toBe(resolve(accountHome, ".mono-agent", "logs"));
      expect(paths.launchAgentsDir).not.toContain(process.env.HOME);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});

describe("escapeXml", () => {
  it("escapes all five XML entities", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("buildPlistXml", () => {
  it("clears launchd's inherited environment before running the foreground worker", () => {
    const xml = buildPlistXml(plistInput());
    expect(xml).toContain("<string>/usr/bin/env</string>");
    expect(xml).toContain("<string>-i</string>");
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/opt/app/dist/cli.js</string>");
    expect(xml).toContain("<string>start</string>");
    expect(xml).toContain("<string>--foreground</string>");
    expect(xml).toContain("<string>--config</string>");
    expect(xml).toContain("<string>/work/demo/mono-agent.config.json</string>");
    // Argument order: env, -i, explicit values, node, cli, start, flags.
    expect(xml.indexOf("/usr/bin/env")).toBeLessThan(xml.indexOf("-i"));
    expect(xml.indexOf("-i")).toBeLessThan(xml.indexOf("PATH=/usr/bin:/bin"));
    expect(xml.indexOf("PATH=/usr/bin:/bin")).toBeLessThan(xml.indexOf("/usr/local/bin/node"));
    expect(xml.indexOf("start")).toBeLessThan(xml.indexOf("--foreground"));
    expect(xml.indexOf("--foreground")).toBeLessThan(xml.indexOf("--config"));
    expect(xml).toContain("<string>--expected-background-snapshot</string>");
    expect(xml).toContain("<string>approved-background-snapshot</string>");
  });

  it("passes --env-file to the worker when set", () => {
    const xml = buildPlistXml(plistInput({ envFile: "/work/demo/.env.local" }));
    expect(xml).toContain("<string>--env-file</string>");
    expect(xml).toContain("<string>/work/demo/.env.local</string>");
    expect(buildPlistXml(plistInput())).not.toContain("--env-file");
  });

  it("restarts only on crash and runs at load", () => {
    const xml = buildPlistXml(plistInput());
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u);
    expect(xml).toContain("<key>ProcessType</key>\n  <string>Interactive</string>");
    expect(xml).toContain("<key>ThrottleInterval</key>\n  <integer>10</integer>");
  });

  it("restores only explicit operational values as env -i arguments", () => {
    const xml = buildPlistXml(plistInput({
      environment: { HOME: "/home/u", PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
    }));
    expect(xml).not.toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<string>HOME=/home/u</string>");
    expect(xml).toContain("<string>PATH=/usr/bin:/bin:/opt/homebrew/bin</string>");
    expect(xml.indexOf("HOME=/home/u")).toBeLessThan(xml.indexOf("PATH=/usr/bin"));
  });

  it("XML-escapes paths that contain ampersands", () => {
    const xml = buildPlistXml(plistInput({ cwd: "/work/A & B", configPath: "/work/A & B/mono-agent.config.json" }));
    expect(xml).toContain("<string>/work/A &amp; B</string>");
    expect(xml).not.toMatch(/<string>[^<]*\s&\s[^<]*<\/string>/u);
  });
});

describe("parseLaunchdServicePid", () => {
  it("extracts a positive top-level pid from launchctl print output", () => {
    expect(parseLaunchdServicePid("service = {\n\tpid = 4321\n\tlast exit code = 0\n}\n")).toBe(4321);
  });

  it("rejects absent, zero, and inline pid-like noise", () => {
    expect(parseLaunchdServicePid("state = waiting\n")).toBeUndefined();
    expect(parseLaunchdServicePid("pid = 0\n")).toBeUndefined();
    expect(parseLaunchdServicePid("note = pid = 999\n")).toBeUndefined();
  });
});

describe("defaultPathEnv", () => {
  it("falls back to a sane PATH when none is present", () => {
    expect(defaultPathEnv({})).toContain("/usr/bin");
    expect(defaultPathEnv({})).toContain("/opt/homebrew/bin");
  });

  it("keeps the current PATH first and appends missing extras", () => {
    const result = defaultPathEnv({ PATH: "/custom/bin" });
    expect(result.startsWith("/custom/bin")).toBe(true);
    expect(result).toContain("/opt/homebrew/bin");
  });

  it("does not duplicate extras already present", () => {
    const result = defaultPathEnv({ PATH: "/opt/homebrew/bin:/usr/bin" });
    expect(result.split(":").filter((part) => part === "/opt/homebrew/bin")).toHaveLength(1);
  });
});

describe("launchctl targets", () => {
  it("builds gui domain and service targets", () => {
    expect(domainTarget(501)).toBe("gui/501");
    expect(serviceTarget("com.mono-agent.demo-0a1b2c3d", 501)).toBe("gui/501/com.mono-agent.demo-0a1b2c3d");
  });
});
