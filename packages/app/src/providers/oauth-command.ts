import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

export function resolvePiCliPath(): string {
  // App-owned wrapper, provider-owned OAuth: unlike Pi's generic CLI this
  // supplies onManualCodeInput, so a full redirect URL pasted into the terminal
  // reaches Anthropic's state-validating parser.
  return fileURLToPath(new URL("../pi-oauth-login-main.js", import.meta.url));
}

export function piLoginCommand(provider: string, piCliPath = resolvePiCliPath(), durableAuthPath?: string): readonly [string, ...string[]] {
  return [process.execPath, piCliPath, provider, ...(provider === "openai" && durableAuthPath !== undefined ? [durableAuthPath] : [])];
}

export function piAuthRecoveryCommand(provider: string, piAuthPath?: string): string {
  return piAuthPath === undefined
    ? `mono-agent auth login ${shellQuote(provider)}`
    : `mono-agent auth login ${shellQuote(provider)} --pi-auth-path ${shellQuote(piAuthPath)}`;
}

export function piAuthWorkingDirectory(piAuthPath: string | undefined, cwd = process.cwd()): string {
  return dirname(piAuthPathForSetup(piAuthPath, cwd));
}

export function piAuthPathForSetup(piAuthPath: string | undefined, cwd = process.cwd()): string {
  if (piAuthPath === undefined || piAuthPath.trim().length === 0) {
    return DEFAULT_PI_AUTH_PATH;
  }
  const normalized = piAuthPath.trim();
  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return resolve(homedir(), normalized.slice(2));
  }
  return resolve(cwd, normalized);
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
