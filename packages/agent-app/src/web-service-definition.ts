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
  const webIndex = argv.indexOf("web");
  if (webIndex <= 0 || argv.lastIndexOf("web") !== webIndex) return undefined;
  if (argv[webIndex + 1] !== "run") return undefined;
  // The token before `web` is the CLI entrypoint in every generated definition
  // (`node <cli> web run …`, and `… node -- <cli> web run …` on Linux); it must
  // be a path-like token, not another option.
  const entrypoint = argv[webIndex - 1];
  if (entrypoint === undefined || entrypoint.length === 0 || entrypoint.startsWith("-")) return undefined;

  const values = new Map<string, string>();
  const suffix = argv.slice(webIndex + 2);
  for (let index = 0; index < suffix.length; index += 2) {
    const flag = suffix[index];
    const value = suffix[index + 1];
    if (flag === undefined || value === undefined || !MANAGED_WEB_OPTION_NAMES.includes(flag)) return undefined;
    if (values.has(flag)) return undefined;
    values.set(flag, value);
  }

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
