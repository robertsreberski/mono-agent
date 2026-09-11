import { createHash } from "node:crypto";

export const MANAGED_BACKGROUND_WORKER_ENV = "MONO_AGENT_MANAGED_WORKER";
/** Marks the scrubbed foreground worker installed by the Linux systemd lifecycle. */
export const SYSTEMD_BACKGROUND_WORKER_ENV = "MONO_AGENT_SYSTEMD_WORKER";

/** Host/session values required by a Linux systemd user worker. */
export const SYSTEMD_BACKGROUND_OPERATIONAL_ENV_NAMES = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

/**
 * Non-secret host variables that a managed worker may inherit durably.
 *
 * Provider credentials and MONO_AGENT_* config overrides deliberately do not
 * belong here: secrets come from the selected dotenv file and product config
 * comes from the committed JSON. Keeping this list shared between first-run
 * validation, launchd materialisation, and worker proof prevents the three
 * surfaces from quietly validating different environments.
 */
export const BACKGROUND_OPERATIONAL_ENV_NAMES = [
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "ComSpec",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SHELL",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
] as const;

const BACKGROUND_OPERATIONAL_ENV_SET: ReadonlySet<string> = new Set(BACKGROUND_OPERATIONAL_ENV_NAMES);
const SYSTEMD_BACKGROUND_OPERATIONAL_ENV_SET: ReadonlySet<string> = new Set([
  ...BACKGROUND_OPERATIONAL_ENV_NAMES,
  ...SYSTEMD_BACKGROUND_OPERATIONAL_ENV_NAMES,
]);

export function isBackgroundOperationalEnvName(name: string): boolean {
  return BACKGROUND_OPERATIONAL_ENV_SET.has(name);
}

export function isSystemdBackgroundOperationalEnvName(name: string): boolean {
  return SYSTEMD_BACKGROUND_OPERATIONAL_ENV_SET.has(name);
}

function selectOperationalEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = env[name];
      return typeof value === "string" ? [[name, value] as const] : [];
    }),
  );
}

/** Select a deterministic, non-secret environment suitable for a managed worker. */
export function selectBackgroundOperationalEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return selectOperationalEnvironment(env, BACKGROUND_OPERATIONAL_ENV_NAMES);
}

/** Select the shared background values plus Linux systemd user-session values. */
export function selectSystemdBackgroundOperationalEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return selectOperationalEnvironment(env, [
    ...BACKGROUND_OPERATIONAL_ENV_NAMES,
    ...SYSTEMD_BACKGROUND_OPERATIONAL_ENV_NAMES,
  ]);
}

function fingerprintOperationalEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string {
  const selected = selectOperationalEnvironment(env, names);
  const hash = createHash("sha256");
  hash.update("mono-agent-background-operational-env-v1\0", "utf8");
  for (const name of names) {
    const value = selected[name];
    if (value === undefined) continue;
    hash.update(name, "utf8");
    hash.update("\0", "utf8");
    hash.update(value, "utf8");
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Opaque proof only; no environment value is written to trace metadata. */
export function fingerprintBackgroundOperationalEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return fingerprintOperationalEnvironment(env, BACKGROUND_OPERATIONAL_ENV_NAMES);
}

/** Opaque proof of shared plus Linux systemd session values. */
export function fingerprintSystemdBackgroundOperationalEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return fingerprintOperationalEnvironment(env, [
    ...BACKGROUND_OPERATIONAL_ENV_NAMES,
    ...SYSTEMD_BACKGROUND_OPERATIONAL_ENV_NAMES,
  ]);
}
