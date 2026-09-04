// @ts-check

/**
 * Startup-file and shell-option environment neutralization shared by every tool
 * that spawns `/bin/bash -c`. Kept in one place so a monitor's command
 * environment cannot drift away from Bash's.
 */
const BASH_STARTUP_ENV_KEYS = new Set([
  "BASHOPTS",
  "BASH_COMPAT",
  "BASH_XTRACEFD",
  "CDPATH",
  "GLOBIGNORE",
  "POSIXLY_CORRECT",
  "PROMPT_COMMAND",
  "PS4",
  "SHELLOPTS",
]);

export function cleanBashEnvironment(sourceEnv = process.env) {
  const env = {
    BASH_ENV: "/dev/null",
    ENV: "/dev/null",
  };
  for (const key of Object.keys(sourceEnv)) {
    if (BASH_STARTUP_ENV_KEYS.has(key) || key.startsWith("BASH_FUNC_")) {
      env[key] = undefined;
    }
  }
  return env;
}
