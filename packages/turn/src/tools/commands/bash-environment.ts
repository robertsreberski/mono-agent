// @ts-check

/**
 * Startup-file and shell-option environment neutralization shared by every tool
 * that spawns `/bin/bash -c`. Kept in one place so a command
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

export function cleanBashEnvironment(sourceEnv: NodeJS.ProcessEnv = process.env): { BASH_ENV: string; ENV: string } {
  const env: Record<string, string | undefined> & { BASH_ENV: string; ENV: string } = {
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
