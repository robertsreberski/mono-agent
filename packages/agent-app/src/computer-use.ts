import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";

import { loadToolPolicyFromJsonFileSync, type ToolPolicyInput } from "@mono-agent/agent-harness";
import { MonoAgentConfigError, type MonoAgentConfig } from "@mono-agent/config";
import type { ValidationSection } from "./doctor-types.js";

export const COMPUTER_USE_SERVER_NAME = "computer-use";
type ComputerUseConfig = NonNullable<MonoAgentConfig["tools"]["computerUse"]>;

interface BinaryResolutionOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly cwd?: string;
  readonly executable?: (path: string) => boolean;
}

/** Explicit overrides never fall back to a different installation. */
export function resolveCuaDriverCommand(command?: string, options: BinaryResolutionOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const paths = platform === "win32" ? win32 : { join, resolve, isAbsolute };
  const executable = options.executable ?? ((path: string) => {
    try {
      accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
      return statSync(path).isFile();
    } catch { return false; }
  });
  if (command !== undefined && (paths.isAbsolute(command) || /[\\/]/u.test(command))) {
    const path = paths.resolve(cwd, command);
    return executable(path) ? path : undefined;
  }
  const name = command ?? (platform === "win32" ? "cua-driver.exe" : "cua-driver");
  const names = platform === "win32" && !name.toLowerCase().endsWith(".exe") ? [name, `${name}.exe`] : [name];
  const candidates = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter)
    .filter((part) => part.length > 0)
    .flatMap((part) => names.map((entry) => paths.resolve(cwd, part, entry)));
  if (command === undefined) {
    candidates.push(...(platform === "win32"
      ? [paths.join(env.LOCALAPPDATA ?? paths.join(home, "AppData", "Local"), "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe")]
      : [join(home, ".local", "bin", "cua-driver"), ...(platform === "darwin" ? ["/Applications/CuaDriver.app/Contents/MacOS/cua-driver"] : [])]));
  }
  return candidates.find(executable);
}

export function assertComputerUseServerNameAvailable(servers: Record<string, unknown>): void {
  if (Object.hasOwn(servers, COMPUTER_USE_SERVER_NAME)) {
    throw new MonoAgentConfigError("invalid_json", 'MCP server name "computer-use" is reserved when tools.computerUse is enabled; rename the entry in tools.mcpConfigPath.');
  }
}

/** Shared by primary runs, harness policy and ordinary subagent MCP selection. */
export function configuredToolPolicyInput(config: MonoAgentConfig): ToolPolicyInput {
  const filePolicy = config.tools.mcpConfigPath === undefined ? undefined : loadToolPolicyFromJsonFileSync(config.tools.mcpConfigPath);
  let servers = filePolicy?.mcpServers;
  if (config.tools.computerUse !== undefined) {
    assertComputerUseServerNameAvailable(servers ?? {});
    const command = resolveCuaDriverCommand(config.tools.computerUse.command, { cwd: config.runtime.workspace });
    if (command === undefined) {
      throw new MonoAgentConfigError("invalid_json", "tools.computerUse: cua-driver executable not found; install it separately or set tools.computerUse.command. See docs/tools/computer-use.md.");
    }
    servers = { ...servers, [COMPUTER_USE_SERVER_NAME]: { command, args: ["mcp"] } };
  }
  return {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
    ...(config.tools.mcpConfigPath === undefined ? {} : { mcpConfigPath: config.tools.mcpConfigPath }),
    ...(servers === undefined ? {} : { mcpServers: servers }),
  };
}

const runFile = promisify(execFile);
type Probe = (command: string, args: readonly string[]) => Promise<string>;
const probe: Probe = async (command, args) => {
  const result = await runFile(command, [...args], { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true });
  return result.stdout;
};

/** No screenshot/input tools, grants, installation, or raw CLI output in doctor. */
export async function computerUseSection(config: ComputerUseConfig | undefined, options: {
  readonly platform?: NodeJS.Platform;
  readonly resolveCommand?: (command?: string) => string | undefined;
  readonly probe?: Probe;
} = {}): Promise<ValidationSection> {
  const section = (status: ValidationSection["status"], details: readonly string[]): ValidationSection => ({ id: "computer-use", label: "Computer use", status, details });
  if (config === undefined) return section("disabled", ["tools.computerUse is not configured."]);
  const command = (options.resolveCommand ?? resolveCuaDriverCommand)(config.command);
  if (command === undefined) return section("waiting", ["cua-driver is not installed or not executable. Install from https://cua.ai/docs/cua-driver or set tools.computerUse.command to its absolute path."]);
  const details = [`Executable: ${command}.`, "Standard invocation; mono-agent does not configure or verify daemon permission mode."];
  const run = options.probe ?? probe;
  try {
    const version = (await run(command, ["--version"])).trim();
    if (!/^cua-driver \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)) {
      return section("waiting", [...details, "Unable to confirm cua-driver version; check the executable."]);
    }
    details.push(`Version: ${version}.`);
    const report: unknown = JSON.parse(await run(command, ["doctor", "--json"]));
    if (!isRecord(report) || report.ok !== true) {
      return section("waiting", [...details, "cua-driver install/runtime checks are not ready. Run cua-driver doctor interactively."]);
    }
    if ((options.platform ?? process.platform) === "darwin") {
      const permissions: unknown = JSON.parse(await run(command, ["permissions", "status", "--json"]));
      if (!isRecord(permissions) || (permissions.status !== undefined && !["ok", "ready", "granted"].includes(String(permissions.status)))
        || permissions.daemon_running === false || permissions.accessibility !== true || permissions.screen_recording !== true
        || permissions.screen_recording_capturable === false) {
        return section("waiting", [...details, "CuaDriver daemon/Accessibility/Screen Recording readiness is not confirmed (unknown or pending). Run cua-driver permissions grant from an interactive session; check System Settings → Privacy & Security, then rerun doctor."]);
      }
    }
    return section("ok", details);
  } catch {
    return section("waiting", [...details, "cua-driver readiness probe failed, timed out, or returned unrecognized JSON. Run cua-driver doctor and permissions status interactively."]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
