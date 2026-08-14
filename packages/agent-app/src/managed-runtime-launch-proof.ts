const MANAGED_RUNTIME_LAUNCH_PROOF_SCHEMA = "mono-agent.managed-runtime-launch.v2";
const MAX_MANAGED_RUNTIME_LAUNCH_PROOF_BYTES = 2 * 1024;

export interface ManagedRuntimeLaunchProof {
  readonly schema: typeof MANAGED_RUNTIME_LAUNCH_PROOF_SCHEMA;
  readonly markerSha256: string;
  readonly maintenanceEntrySha256: string;
  readonly installedAt: string;
}

export function encodeManagedRuntimeLaunchProof(proof: ManagedRuntimeLaunchProof): string {
  return Buffer.from(JSON.stringify(proof), "utf8").toString("base64url");
}

export function decodeManagedRuntimeLaunchProof(encoded: string): ManagedRuntimeLaunchProof {
  if (typeof encoded !== "string"
    || encoded.length === 0
    || encoded.length > MAX_MANAGED_RUNTIME_LAUNCH_PROOF_BYTES * 2
    || !/^[0-9A-Za-z_-]+$/u.test(encoded)) {
    throw new Error("The managed runtime launch proof is malformed.");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    throw new Error("The managed runtime launch proof is malformed.");
  }
  if (bytes.length === 0
    || bytes.length > MAX_MANAGED_RUNTIME_LAUNCH_PROOF_BYTES
    || bytes.toString("base64url") !== encoded) {
    throw new Error("The managed runtime launch proof is malformed.");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("The managed runtime launch proof is not valid JSON.");
  }
  if (!isRecord(value)
    || !hasExactKeys(value, ["schema", "markerSha256", "maintenanceEntrySha256", "installedAt"])) {
    throw new Error("The managed runtime launch proof has an invalid schema.");
  }
  const installedAtMs = typeof value.installedAt === "string" ? Date.parse(value.installedAt) : Number.NaN;
  if (value.schema !== MANAGED_RUNTIME_LAUNCH_PROOF_SCHEMA
    || !isSha256(value.markerSha256)
    || !isSha256(value.maintenanceEntrySha256)
    || typeof value.installedAt !== "string"
    || !Number.isFinite(installedAtMs)
    || new Date(installedAtMs).toISOString() !== value.installedAt
    || value.installedAt === "1970-01-01T00:00:00.000Z") {
    throw new Error("The managed runtime launch proof has an invalid schema.");
  }
  return value as unknown as ManagedRuntimeLaunchProof;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
