// Shared guarded-run mechanics; policy is selected only by a closed protocol id.
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
const instances = new Map();
export function guardedChildEnvironment(id) {
  const protocol = guardedProtocol(id);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, id));
  return instances.get(protocol);
}
function bind(protocol, id) {
  async function childEnvironment(home) {
    await mkdir(home, { recursive: true, mode: 0o700 });
    return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "CI", "CONTINUITY_DEBUG"].includes(key))),
      HOME: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  }
  function childImports() {
    const result = [];
    const absolute = value => value.startsWith("./") || value.startsWith("../") ? new URL(value, pathToFileURL(`${process.cwd()}/`)).href : value;
    for (let i = 0; i < process.execArgv.length; i++) {
      if (process.execArgv[i] === "--import" && process.execArgv[i + 1]) result.push("--import", absolute(process.execArgv[++i]));
      else if (process.execArgv[i].startsWith("--import=")) result.push("--import=" + absolute(process.execArgv[i].slice("--import=".length)));
    }
    return result;
  }
  return Object.freeze({ childEnvironment, childImports });
}
