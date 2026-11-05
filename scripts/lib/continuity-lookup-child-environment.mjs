import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";

/** No ambient credential keys or NODE_OPTIONS; presence-sensitive safety flags survive. */
export async function lookupChildEnvironment(home) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "CI", "CONTINUITY_DEBUG"].includes(key))),
    HOME: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}
/** Only explicit imports, never inherited inspector/loader options or NODE_OPTIONS. */
export function lookupChildImports() {
  const result = [];
  const absolute = value => value.startsWith("./") || value.startsWith("../") ? new URL(value, pathToFileURL(`${process.cwd()}/`)).href : value;
  for (let i = 0; i < process.execArgv.length; i++) {
    if (process.execArgv[i] === "--import" && process.execArgv[i + 1]) result.push("--import", absolute(process.execArgv[++i]));
    else if (process.execArgv[i].startsWith("--import=")) result.push("--import=" + absolute(process.execArgv[i].slice("--import=".length)));
  }
  return result;
}
