import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const MANAGED_SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";
export const MANAGED_SRT_VERSION = "0.0.64";
export const MANAGED_SRT_LOCK_SHA256 = "2afca4e80a1110eca9473f04a48240ef646e251fcf4bb9dbd228d7c20230c186";
export const MANAGED_SRT_TREE_SHA256 = "8dd7983d664c195474d12b431113487ff750a6721af91c6e97cd968692a6a25d";
export const MANAGED_SRT_MARKER = ".mono-agent-srt.json";

export interface ManagedSrtMarker<TreeSha256 extends string = typeof MANAGED_SRT_TREE_SHA256> {
  readonly schemaVersion: 2;
  readonly package: typeof MANAGED_SRT_PACKAGE;
  readonly version: typeof MANAGED_SRT_VERSION;
  readonly lockSha256: typeof MANAGED_SRT_LOCK_SHA256;
  readonly cliSha256: string;
  readonly packageJsonSha256: string;
  readonly treeSha256: TreeSha256;
}

export function managedSrtInstallRoot(input: {
  readonly cacheRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
} = {}): string {
  const cacheRoot = input.cacheRoot ?? managedSrtCacheRoot(input);
  return resolve(cacheRoot, "mono-agent", "tools", "srt", MANAGED_SRT_VERSION, MANAGED_SRT_LOCK_SHA256);
}

export function managedSrtCacheRoot(input: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
} = {}): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) {
    return resolve(xdg);
  }
  const homeDir = input.homeDir ?? homedir();
  return platform === "darwin"
    ? resolve(homeDir, "Library", "Caches")
    : resolve(homeDir, ".cache");
}
