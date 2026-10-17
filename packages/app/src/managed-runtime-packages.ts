import { readFile, realpath } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, resolve } from "node:path";

import { loadAppCoreConfig } from "./composition/app-config.js";
import { configuredChannelPluginPackageNames } from "./channel-plugins.js";
import type { ManagedRuntimeAdditionalPackage } from "./service/managed-runtime/types.js";

interface ResolveManagedRuntimePackagesInput {
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Resolve the exact config-selected plugin roots observed by the current app install. */
export async function resolveConfiguredManagedRuntimePackages(
  input: ResolveManagedRuntimePackagesInput,
): Promise<readonly ManagedRuntimeAdditionalPackage[]> {
  const cwd = resolve(input.cwd);
  const [channelPackages] = await Promise.all([
    configuredChannelPluginPackageNames(input.configPath),
    loadAppCoreConfig({ cwd, configPath: input.configPath, env: input.env }),
  ]);
  const requirements = new Set(channelPackages);

  const appBase = import.meta.url;
  const resolved = await Promise.all([...requirements]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map(async (packageName) => ({
      packageName,
      packageSource: await resolveInstalledPackageRoot(
        packageName,
        [appBase],
      ),
    })));
  return resolved;
}

async function resolveInstalledPackageRoot(
  packageName: string,
  bases: readonly string[],
): Promise<string> {
  let lastError: unknown;
  for (const base of bases) {
    try {
      const manifestPath = findPackageJSON(packageName, base);
      if (manifestPath === undefined) {
        throw new Error(`Cannot resolve ${packageName} from ${base}.`);
      }
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
      if (parsed.name !== packageName) {
        throw new Error(`${manifestPath} declares ${String(parsed.name)}, expected ${packageName}.`);
      }
      return await realpath(dirname(manifestPath));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Cannot preserve configured managed-runtime package ${packageName}: ` +
    `${lastError instanceof Error ? lastError.message : String(lastError)}. ` +
    "Install the package beside @mono-agent/app before starting the background agent.",
  );
}
