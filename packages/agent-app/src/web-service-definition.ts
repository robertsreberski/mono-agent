import type { WebTheme } from "@mono-agent/web";

/**
 * Fresh-install bind for the CLI console commands. A pristine install binds
 * loopback; `--host <addr>` widens it explicitly, and `--share-tailnet` (macOS
 * managed start/restart) publishes an owned Tailscale Serve route. Installed
 * services keep whatever bind they were published with. The `@mono-agent/web`
 * library keeps its own independent default; this constant governs the CLI.
 */
export const DEFAULT_WEB_HOST = "127.0.0.1";
export const DEFAULT_WEB_PORT = 5050;
/** The CLI's historical wide bind: what a definition without `--host` used to run. */
export const LEGACY_DEFAULT_WEB_HOST = "0.0.0.0";

export const WEB_THEMES = ["evergreen", "ocean", "plum", "terracotta"] as const satisfies readonly WebTheme[];
export const DEFAULT_WEB_THEME: WebTheme = "evergreen";

// Mirrors WEB_CONSOLE_NAME_MAX_CHARACTERS in @mono-agent/web; declared locally so
// this module keeps a type-only dependency on the lazily loaded web package.
export const WEB_CONSOLE_NAME_MAX_CHARACTERS = 80 satisfies typeof import("@mono-agent/web").WEB_CONSOLE_NAME_MAX_CHARACTERS;

/** True when `value` is one of the curated console themes. */
export function isWebTheme(value: unknown): value is WebTheme {
  return typeof value === "string" && (WEB_THEMES as readonly string[]).includes(value);
}

/** Reject labels the manifest, launchd argv, or launcher cannot carry faithfully. */
export function invalidWebConsoleName(value: string): string | undefined {
  const name = value.trim();
  if (name.length === 0) return "--name must not be empty.";
  if (/[\u0000-\u001f\u007f-\u009f\u2028-\u202e]/u.test(name)) {
    return "--name must not contain control characters, line separators, or bidirectional overrides.";
  }
  if ([...name].length > WEB_CONSOLE_NAME_MAX_CHARACTERS) {
    return `--name must be at most ${String(WEB_CONSOLE_NAME_MAX_CHARACTERS)} characters.`;
  }
  return undefined;
}

/** A persisted managed worker definition, recovered from a plist or systemd unit. */
export interface ManagedWebDefinition {
  readonly host: string;
  readonly port: number;
  readonly theme: WebTheme;
  readonly name?: string;
}

const MANAGED_WEB_OPTION_NAMES: readonly string[] = ["--host", "--port", "--theme", "--name"];

/**
 * `env -i` environment assignment as both builders write it
 * (`buildEnvironmentArguments` / `operationalEnvironment`).
 */
const MANAGED_WEB_ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** A launcher/entrypoint token: non-empty and not another option. */
function isPathToken(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !value.startsWith("-");
}

/** One `--flag value` pair, unique per flag, with the value kept as opaque data. */
function readManagedOptionPairs(
  suffix: readonly string[],
): ReadonlyMap<string, string> | undefined {
  const values = new Map<string, string>();
  for (let index = 0; index < suffix.length; index += 2) {
    const flag = suffix[index];
    const value = suffix[index + 1];
    if (flag === undefined || value === undefined || !MANAGED_WEB_OPTION_NAMES.includes(flag)) return undefined;
    if (values.has(flag)) return undefined;
    values.set(flag, value);
  }
  return values;
}

/** Binds must be a single printable, non-flag token; the actual bind is proven by the worker. */
function isValidManagedBindHost(value: string): boolean {
  const host = value.trim();
  return host.length > 0
    && host === value
    && host.length <= 255
    && !host.startsWith("-")
    && !/[\u0000-\u0020\u007f]/u.test(host);
}

/**
 * Decode the managed `web run` invocation persisted by `buildWebLaunchdProgramArguments`
 * (macOS LaunchAgent) or `workerArgv` (Linux systemd unit).
 *
 * Returns `undefined` unless argv is `<launcher prefix> <cli entrypoint> web run <options>`
 * with one value per recognized option and no unknown or duplicated token, so a
 * caller can fail closed instead of reinterpreting an unrelated command as an
 * owned web definition. Three deliberate legacy omissions are preserved:
 * `--name` (pre-name definitions), `--theme` (pre-theme definitions; evergreen)
 * and `--host` (definitions written while the worker's own default was the
 * historical wide bind).
 */
export function decodeManagedWebDefinition(argv: readonly string[]): ManagedWebDefinition | undefined {
  // Both generated prefixes start with `env -i` (buildLaunchdProgramArguments /
  // workerArgv). The command is decoded only at this fixed boundary — never by
  // searching for marker tokens anywhere in argv — so option values such as a
  // console named `web` or `run` stay data.
  let index = 0;
  if (argv[index] !== "/usr/bin/env") return undefined;
  index += 1;
  if (argv[index] !== "-i") return undefined;
  index += 1;
  while (index < argv.length && MANAGED_WEB_ENVIRONMENT_ASSIGNMENT.test(argv[index] ?? "")) index += 1;
  // Node entrypoint, then the optional Linux `--` separator, then the CLI path.
  if (!isPathToken(argv[index])) return undefined;
  index += 1;
  if (argv[index] === "--") index += 1;
  if (!isPathToken(argv[index])) return undefined;
  index += 1;
  if (argv[index] !== "web" || argv[index + 1] !== "run") return undefined;
  index += 2;

  const values = readManagedOptionPairs(argv.slice(index));
  if (values === undefined) return undefined;

  const port = Number(values.get("--port"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
  const theme = values.get("--theme") ?? DEFAULT_WEB_THEME;
  if (!isWebTheme(theme)) return undefined;
  const host = values.get("--host") ?? LEGACY_DEFAULT_WEB_HOST;
  if (!isValidManagedBindHost(host)) return undefined;
  const name = values.get("--name");
  if (name !== undefined && invalidWebConsoleName(name) !== undefined) return undefined;
  return { host, port, theme, ...(name === undefined ? {} : { name }) };
}
