import process from "node:process";

import { decodeManagedWebDefinition } from "./web-service-definition.js";
import type { ManagedWebDefinition } from "./web-service-definition.js";
import {
  buildEnvironmentArguments,
  buildWebMaintenancePlistXml,
  INTERNAL_WEB_LOG_MAINTENANCE_COMMAND,
  WEB_MAINTENANCE_LAUNCHD_LABEL,
} from "../launchd/launchd.js";
import type { LaunchdWebMaintenanceDefinition } from "../launchd/launchd.js";
import { inspectOwnerPrivateLaunchdPlist, readOwnerPrivateLaunchdPlist } from "../launchd/plist-files.js";
import { managedWebLogMaintenanceEnvironment } from "../launchd/managed-web-maintenance-environment.js";
import { verifyManagedRuntimeMaintenanceEntrypoint } from "../managed-runtime/managed-runtime-maintenance-entry.js";
import type { ManagedWebPaths } from "./web-maintenance-paths.js";
import { urlHost } from "./presentation.js";
import type { WebMaintenancePublicationInputs } from "./types.js";

/**
 * Recover the published console definition from a stopped install's main
 * LaunchAgent plist. Returns undefined unless the persisted argv is a
 * recognized managed `web run` invocation, so the caller refuses instead of
 * guessing a fresh default for an existing service.
 */
export function installedWebDefinition(xml: string): ManagedWebDefinition | undefined {
  let args: readonly string[];
  try {
    args = plistProgramArguments(xml);
  } catch {
    return undefined;
  }
  return decodeManagedWebDefinition(args);
}

export async function inspectInstalledWebMaintenanceHelper(
  paths: ManagedWebPaths,
  expectedMainIdentity?: string,
  verifyEntrypoint: typeof verifyManagedRuntimeMaintenanceEntrypoint = verifyManagedRuntimeMaintenanceEntrypoint,
  loadedDefinition?: LaunchdWebMaintenanceDefinition,
  requireLoadedDefinition = false,
): Promise<WebMaintenancePublicationInputs> {
  const helper = await readOwnerPrivateLaunchdPlist(paths.maintenancePlistPath);
  const strings = plistProgramArguments(helper.contents);
  const expectedPrefix = [
    "/usr/bin/env",
    "-i",
    ...buildEnvironmentArguments(managedWebLogMaintenanceEnvironment()),
  ];
  const nodeIndex = expectedPrefix.length;
  if (strings.length !== expectedPrefix.length + 7
    || expectedPrefix.some((value, index) => strings[index] !== value)
    || strings[nodeIndex + 2] !== INTERNAL_WEB_LOG_MAINTENANCE_COMMAND
    || strings[nodeIndex + 3] !== "--expected-managed-runtime-launch"
    || strings[nodeIndex + 5] !== "--expected-web-plist-identity") {
    throw new Error("The web-maintenance helper has an unexpected private argv definition.");
  }
  const nodePath = strings[nodeIndex]!;
  const cliPath = strings[nodeIndex + 1]!;
  const expectedManagedRuntimeLaunch = strings[nodeIndex + 4]!;
  const embeddedMainIdentity = strings[nodeIndex + 6]!;
  const cwd = plistStringForKey(helper.contents, "WorkingDirectory");
  const calendarMinute = plistIntegerForKey(helper.contents, "Minute");
  const inputs: WebMaintenancePublicationInputs = {
    nodePath,
    cliPath,
    cwd,
    expectedManagedRuntimeLaunch,
    environment: managedWebLogMaintenanceEnvironment(),
    calendarMinute,
  };
  const rebuilt = buildWebMaintenancePlistXml({
    label: WEB_MAINTENANCE_LAUNCHD_LABEL,
    ...inputs,
    expectedWebPlistIdentity: embeddedMainIdentity,
  });
  if (rebuilt !== helper.contents) throw new Error("The web-maintenance helper definition is not canonical.");
  const mainIdentity = await inspectOwnerPrivateLaunchdPlist(paths.launchd.plistPath);
  if (embeddedMainIdentity !== mainIdentity
    || (expectedMainIdentity !== undefined && expectedMainIdentity !== mainIdentity)) {
    throw new Error("The web-maintenance helper does not carry the current composite main-plist identity.");
  }
  if (loadedDefinition !== undefined
    && (loadedDefinition.plistPath !== paths.maintenancePlistPath
      || loadedDefinition.nodePath !== nodePath
      || loadedDefinition.cliPath !== cliPath
      || loadedDefinition.cwd !== cwd
      || loadedDefinition.expectedManagedRuntimeLaunch !== expectedManagedRuntimeLaunch
      || loadedDefinition.expectedWebPlistIdentity !== embeddedMainIdentity)) {
    throw new Error("launchd's cached web-maintenance helper definition does not match the paired plist.");
  }
  if (loadedDefinition === undefined && requireLoadedDefinition) {
    throw new Error("launchd did not expose the cached web-maintenance helper definition.");
  }
  await verifyEntrypoint({
    currentEntrypointPath: cliPath,
    launchProof: expectedManagedRuntimeLaunch,
  });
  return inputs;
}

function plistProgramArguments(xml: string): readonly string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(xml)?.[1];
  if (array === undefined) throw new Error("The web-maintenance helper is missing ProgramArguments.");
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map((match) => decodeXml(match[1] ?? ""));
}

function plistStringForKey(xml: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = new RegExp(`<key>${escapedKey}<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`, "u").exec(xml)?.[1];
  if (value === undefined) throw new Error(`The web-maintenance helper is missing ${key}.`);
  return decodeXml(value);
}

function plistIntegerForKey(xml: string, key: string): number {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const raw = new RegExp(`<key>${escapedKey}<\\/key>\\s*<integer>([0-9]+)<\\/integer>`, "u").exec(xml)?.[1];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`The web-maintenance helper has an invalid ${key}.`);
  return value;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

export function healthUrl(host: string, port: number): string {
  const checkHost = host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : urlHost(host);
  return `http://${checkHost}:${String(port)}/healthz`;
}

export function requiredUid(): number {
  if (typeof process.getuid !== "function") throw new Error("launchd requires a numeric user id");
  return process.getuid();
}
