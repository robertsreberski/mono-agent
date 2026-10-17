import { constants as fsConstants, type BigIntStats } from "node:fs";
import { chmod, open, writeFile } from "node:fs/promises";
import process from "node:process";

import { isRecord, limitRuntimeStat, lstat, sameSourceStats } from "./inspection-io.js";
import { isExactVersion } from "./layout.js";
import { MANAGED_RUNTIME_MARKER_PACKAGE } from "./types.js";
import type {
  ManagedBackgroundRuntimeDeps,
  ManagedRuntimeProvenanceVerificationInput,
  RuntimeIdentity,
  RuntimeMarker,
} from "./types.js";
export const PROVISIONAL_RUNTIME_INSTALLED_AT = "1970-01-01T00:00:00.000Z";
const MAX_RUNTIME_MARKER_BYTES = 16 * 1024;

export function sameRuntimeMarker(left: RuntimeMarker, right: RuntimeMarker): boolean {
  return left.schema === right.schema
    && left.packageName === right.packageName
    && left.closureManifestSha256 === right.closureManifestSha256
    && left.executionProofSha256 === right.executionProofSha256
    && left.packageVersion === right.packageVersion
    && left.cliSha256 === right.cliSha256
    && left.sourceClosureSha256 === right.sourceClosureSha256
    && left.nodeAbi === right.nodeAbi
    && left.platform === right.platform
    && left.arch === right.arch
    && left.installedAt === right.installedAt
    && (left.schema !== "mono-agent.managed-runtime.v5"
      || (right.schema === "mono-agent.managed-runtime.v5"
        && left.reuseProofSha256 === right.reuseProofSha256));
}

export function runtimeMarkerMatchesProvenance(
  marker: RuntimeMarker,
  input: ManagedRuntimeProvenanceVerificationInput,
): boolean {
  return marker.packageName === MANAGED_RUNTIME_MARKER_PACKAGE
    && marker.closureManifestSha256 === input.closureManifestSha256
    && marker.executionProofSha256 === input.executionProofSha256
    && marker.packageVersion === input.packageVersion
    && marker.cliSha256 === input.cliSha256
    && marker.sourceClosureSha256 === input.sourceClosureSha256
    && marker.nodeAbi === input.nodeAbi
    && marker.platform === input.platform
    && marker.arch === input.arch
    && marker.installedAt === input.installedAt;
}

export async function readRuntimeMarker(
  path: string,
  identity: RuntimeIdentity,
): Promise<RuntimeMarker | undefined> {
  const bytes = await readPrivateRuntimeMarkerBytes(path);
  if (bytes === undefined) return undefined;
  try {
    return runtimeMarkerFromJson(JSON.parse(bytes.toString("utf8")) as unknown, identity);
  } catch {
    return undefined;
  }
}

export async function readPrivateRuntimeMarkerBytes(path: string): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await limitRuntimeStat<BigIntStats>(() => handle!.stat({ bigint: true }));
    if (!privateRuntimeMarkerFile(before)) return undefined;
    const bytes = await handle.readFile();
    const [after, named] = await Promise.all([
      limitRuntimeStat<BigIntStats>(() => handle!.stat({ bigint: true })),
      lstat(path, { bigint: true }),
    ]);
    if (
      !privateRuntimeMarkerFile(after)
      || !privateRuntimeMarkerFile(named)
      || !sameSourceStats(before, after)
      || !sameSourceStats(before, named)
    ) {
      return undefined;
    }
    return bytes;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function privateRuntimeMarkerFile(details: BigIntStats): boolean {
  const owned = typeof process.getuid !== "function" || details.uid === BigInt(process.getuid());
  return details.isFile()
    && !details.isSymbolicLink()
    && details.nlink === 1n
    && details.size <= BigInt(MAX_RUNTIME_MARKER_BYTES)
    && (details.mode & 0o077n) === 0n
    && owned;
}

export function runtimeMarkerFromJson(value: unknown, identity: RuntimeIdentity): RuntimeMarker | undefined {
  if (!isRecord(value)) return undefined;
  const commonKeys = [
    "schema",
    "packageName",
    "closureManifestSha256",
    "executionProofSha256",
    "packageVersion",
    "cliSha256",
    "sourceClosureSha256",
    "nodeAbi",
    "platform",
    "arch",
    "installedAt",
  ];
  const exactKeys = value.schema === "mono-agent.managed-runtime.v5"
    ? [...commonKeys, "reuseProofSha256"]
    : commonKeys;
  const installedAtMs = typeof value.installedAt === "string" ? Date.parse(value.installedAt) : Number.NaN;
  const valid = Object.keys(value).length === exactKeys.length
    && exactKeys.every((key) => Object.hasOwn(value, key))
    && (value.schema === "mono-agent.managed-runtime.v4" || value.schema === "mono-agent.managed-runtime.v5")
    && value.packageName === MANAGED_RUNTIME_MARKER_PACKAGE
    && value.packageVersion === identity.packageVersion
    && value.cliSha256 === identity.cliSha256
    && value.sourceClosureSha256 === identity.sourceClosureSha256
    && value.nodeAbi === identity.nodeAbi
    && value.platform === identity.platform
    && value.arch === identity.arch
    && typeof value.closureManifestSha256 === "string"
    && /^[0-9a-f]{64}$/u.test(value.closureManifestSha256)
    && typeof value.executionProofSha256 === "string"
    && /^[0-9a-f]{64}$/u.test(value.executionProofSha256)
    && (value.schema !== "mono-agent.managed-runtime.v5"
      || (typeof value.reuseProofSha256 === "string" && /^[0-9a-f]{64}$/u.test(value.reuseProofSha256)))
    && typeof value.installedAt === "string"
    && Number.isFinite(installedAtMs)
    && new Date(installedAtMs).toISOString() === value.installedAt
    // Promotion writes this sentinel before the final filesystem proof is
    // rebound. It must remain unverifiable even when the filesystem records
    // both writes with indistinguishable timestamp precision.
    && value.installedAt !== PROVISIONAL_RUNTIME_INSTALLED_AT;
  return valid ? value as unknown as RuntimeMarker : undefined;
}

export function runtimeIdentityFromMarkerJson(value: unknown): RuntimeIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.packageVersion !== "string"
    || !isExactVersion(value.packageVersion)
    || typeof value.cliSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.cliSha256)
    || typeof value.sourceClosureSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.sourceClosureSha256)
    || typeof value.nodeAbi !== "string"
    || value.nodeAbi.length === 0
    || typeof value.platform !== "string"
    || value.platform.length === 0
    || typeof value.arch !== "string"
    || value.arch.length === 0
  ) {
    return undefined;
  }
  return {
    packageVersion: value.packageVersion,
    cliSha256: value.cliSha256,
    sourceClosureSha256: value.sourceClosureSha256,
    nodeAbi: value.nodeAbi,
    platform: value.platform as NodeJS.Platform,
    arch: value.arch,
  };
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, privateJsonContents(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function writeFinalizedRuntimeMarker(
  path: string,
  marker: RuntimeMarker,
  deps: ManagedBackgroundRuntimeDeps,
): Promise<void> {
  // Persist the post-proof boundary. If a write crosses into another second,
  // advance and rewrite so every process from the finalization window remains
  // in the marker's rejected whole-second interval.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const boundaryMs = deps.now();
    await writePrivateJson(path, {
      ...marker,
      installedAt: new Date(boundaryMs).toISOString(),
    });
    if (Math.floor(deps.now() / 1_000) === Math.floor(boundaryMs / 1_000)) return;
  }
  throw new Error("Could not publish a stable managed runtime launch boundary.");
}

export function privateJsonContents(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}
