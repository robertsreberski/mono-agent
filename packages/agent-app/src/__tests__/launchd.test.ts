import { describe, expect, it } from "vitest";

import {
  buildPlistXml,
  defaultPathEnv,
  deriveLaunchdLabel,
  domainTarget,
  escapeXml,
  launchdPathsFor,
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
    noConsole: false,
    stdoutPath: "/home/u/.mono-agent/logs/com.mono-agent.demo-0a1b2c3d.out.log",
    stderrPath: "/home/u/.mono-agent/logs/com.mono-agent.demo-0a1b2c3d.err.log",
    pathEnv: "/usr/bin:/bin",
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
});

describe("escapeXml", () => {
  it("escapes all five XML entities", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("buildPlistXml", () => {
  it("runs the foreground worker with the absolute node, cli, and config paths", () => {
    const xml = buildPlistXml(plistInput());
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/opt/app/dist/cli.js</string>");
    expect(xml).toContain("<string>start</string>");
    expect(xml).toContain("<string>--foreground</string>");
    expect(xml).toContain("<string>--config</string>");
    expect(xml).toContain("<string>/work/demo/mono-agent.config.json</string>");
    // Argument order: node, cli, start, --foreground, --config, <config>.
    expect(xml.indexOf("start")).toBeLessThan(xml.indexOf("--foreground"));
    expect(xml.indexOf("--foreground")).toBeLessThan(xml.indexOf("--config"));
  });

  it("adds --port and --no-console only when requested", () => {
    const withExtras = buildPlistXml(plistInput({ port: 4100, noConsole: true }));
    expect(withExtras).toContain("<string>--port</string>");
    expect(withExtras).toContain("<string>4100</string>");
    expect(withExtras).toContain("<string>--no-console</string>");

    const without = buildPlistXml(plistInput());
    expect(without).not.toContain("--port");
    expect(without).not.toContain("--no-console");
  });

  it("restarts only on crash and runs at load", () => {
    const xml = buildPlistXml(plistInput());
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u);
    expect(xml).toContain("<key>ProcessType</key>\n  <string>Interactive</string>");
    expect(xml).toContain("<key>ThrottleInterval</key>\n  <integer>10</integer>");
  });

  it("only sets PATH in EnvironmentVariables — never secrets", () => {
    const xml = buildPlistXml(plistInput({ pathEnv: "/usr/bin:/bin:/opt/homebrew/bin" }));
    const envBlock = xml.slice(xml.indexOf("<key>EnvironmentVariables</key>"), xml.indexOf("<key>RunAtLoad</key>"));
    const keys = (envBlock.match(/<key>([^<]+)<\/key>/gu) ?? []).map((key) => key.replace(/<\/?key>/gu, ""));
    // The wrapper key plus exactly one inner key (PATH); nothing secret leaks in.
    expect(keys).toEqual(["EnvironmentVariables", "PATH"]);
    expect(envBlock).toContain("/opt/homebrew/bin");
  });

  it("XML-escapes paths that contain ampersands", () => {
    const xml = buildPlistXml(plistInput({ cwd: "/work/A & B", configPath: "/work/A & B/mono-agent.config.json" }));
    expect(xml).toContain("<string>/work/A &amp; B</string>");
    expect(xml).not.toMatch(/<string>[^<]*\s&\s[^<]*<\/string>/u);
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
