import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { agentAppPackageVersion } from "./package-version.js";

export type ImportOptionalPlugin = (specifier: string) => Promise<unknown>;
export type ResolveOptionalPlugin = (
  specifier: string,
  cwd: string,
  preferAppInstall?: boolean,
) => string;

export interface OptionalPluginResolutionOptions {
  /** Agent folder that normally owns an explicitly installed optional plugin. */
  readonly cwd?: string;
  /** Managed workers load only the closure copied beside agent-app. */
  readonly preferAppInstall?: boolean;
  /** Test seam; production uses dynamic import of the resolved entry point. */
  readonly importModule?: ImportOptionalPlugin;
  /** Test seam; production resolves the package manifest using the requested precedence. */
  readonly resolveModule?: ResolveOptionalPlugin;
}

const importOptionalPlugin: ImportOptionalPlugin = async (specifier) =>
  await import(/* @vite-ignore */ specifier);
const resolveOptionalPlugin: ResolveOptionalPlugin = (specifier, cwd, preferAppInstall = false) => {
  const request = `${specifier}/package.json`;
  const appRoot = import.meta.url;
  const agentRoot = resolve(cwd, "package.json");
  // Ordinary installs preserve the established explicit agent-folder
  // override. Managed workers use only the app-side package copied into their
  // attested closure; a missing copy must fail closed, never fall back to
  // mutable agent-local code.
  const searchRoots = preferAppInstall ? [appRoot] : [agentRoot, appRoot];
  let lastError: unknown;
  for (const root of searchRoots) {
    try {
      return createRequire(root).resolve(request);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

export interface OptionalPluginDefinition<T> {
  readonly packageName: string;
  readonly selector: string;
  readonly expectedApi: string;
  readonly isModule: (value: unknown) => value is T;
}

/** Resolve and verify a selected plugin before import or managed-runtime capture. */
export function resolveOptionalPluginManifest(
  definition: Pick<OptionalPluginDefinition<unknown>, "packageName" | "selector">,
  options: Omit<OptionalPluginResolutionOptions, "importModule"> = {},
): string {
  const { packageName } = definition;
  const resolveModule = options.resolveModule ?? resolveOptionalPlugin;
  let manifestPath: string;
  try {
    manifestPath = resolveModule(packageName, options.cwd ?? process.cwd(), options.preferAppInstall === true);
  } catch (error) {
    throw new Error(missingOptionalPluginMessage(definition), { cause: error });
  }
  const appVersion = agentAppPackageVersion();
  const pluginVersion = pluginVersionFromManifest(packageName, manifestPath);
  if (appVersion === undefined) {
    throw new Error("Cannot verify @mono-agent/agent-app version for optional plugin loading; reinstall the application.");
  }
  if (pluginVersion !== appVersion) {
    const problem = pluginVersion === undefined
      ? `${packageName} is installed but its version cannot be verified.`
      : `${packageName}@${pluginVersion} does not match @mono-agent/agent-app@${appVersion}.`;
    throw new Error(`${problem} Install the matching version with \`npm install ${packageName}@${appVersion}\`, then retry.`);
  }
  return manifestPath;
}

/** Only absence is reported as missing; installed module initialization errors retain their cause. */
export async function loadOptionalPlugin<T>(
  definition: OptionalPluginDefinition<T>,
  options: OptionalPluginResolutionOptions = {},
): Promise<T> {
  const manifestPath = resolveOptionalPluginManifest(definition, options);
  const loaded: unknown = await (options.importModule ?? importOptionalPlugin)(
    pluginEntrySpecifier(definition.packageName, manifestPath),
  );
  if (!definition.isModule(loaded)) {
    throw new Error(
      `${definition.packageName} is installed but does not export the expected ${definition.expectedApi}. ` +
      "Install the version matching @mono-agent/agent-app and retry.",
    );
  }
  return loaded;
}

export function installedOptionalPluginVersion(
  packageName: string,
  options: Omit<OptionalPluginResolutionOptions, "importModule"> = {},
): string | undefined {
  try {
    const manifestPath = (options.resolveModule ?? resolveOptionalPlugin)(
      packageName, options.cwd ?? process.cwd(), options.preferAppInstall === true,
    );
    return pluginVersionFromManifest(packageName, manifestPath);
  } catch {
    return undefined;
  }
}

export function isOptionalPluginInstalled(
  packageName: string,
  options: Omit<OptionalPluginResolutionOptions, "importModule"> = {},
): boolean {
  const appVersion = agentAppPackageVersion();
  return appVersion !== undefined && installedOptionalPluginVersion(packageName, options) === appVersion;
}

function pluginVersionFromManifest(packageName: string, manifestPath: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      readonly name?: unknown;
      readonly version?: unknown;
    };
    return manifest.name === packageName && typeof manifest.version === "string"
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
}

function pluginEntrySpecifier(packageName: string, manifestPath: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly main?: unknown;
    readonly exports?: unknown;
  };
  const root = dirname(manifestPath);
  const dotExport = isRecord(manifest.exports) ? manifest.exports["."] : manifest.exports;
  const relativeEntry = typeof dotExport === "string"
    ? dotExport
    : isRecord(dotExport) && typeof dotExport.import === "string"
      ? dotExport.import
      : isRecord(dotExport) && typeof dotExport.default === "string"
        ? dotExport.default
        : typeof manifest.main === "string"
          ? manifest.main
          : undefined;
  if (relativeEntry === undefined) {
    throw new Error(
      `${packageName} is installed but its package manifest has no import entry.`,
    );
  }
  const entry = resolve(root, relativeEntry);
  const relativeToRoot = relative(root, entry);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error(`${packageName} has an invalid import entry outside its package.`);
  }
  return pathToFileURL(entry).href;
}

export function missingOptionalPluginMessage(
  definition: Pick<OptionalPluginDefinition<unknown>, "packageName" | "selector">,
): string {
  const version = agentAppPackageVersion() ?? "<matching-mono-agent-version>";
  return `${definition.selector} requires the optional ${definition.packageName} plugin. ` +
    `Install the matching version with \`npm install ${definition.packageName}@${version}\`, then retry.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
