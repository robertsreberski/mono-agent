// Frozen copies of the persisted-identity readers shipped at a3cb9a611 (before
// the Darwin stable-incarnation change). Do not update these when production
// readers change: they prove records written by new binaries stay readable,
// unchanged, by binaries that still run this code.

const BASELINE_PROCESS_INCARNATION_SCHEMA = "mono-agent.process-incarnation.v1";

interface BaselineProcessIncarnation {
  readonly schema: typeof BASELINE_PROCESS_INCARNATION_SCHEMA;
  readonly bootSessionId: string;
  readonly processStartId: string;
}

/** packages/agent-harness/src/process-incarnation.ts:71-81 at a3cb9a611. */
function baselineProcessIncarnationFromJson(value: unknown): BaselineProcessIncarnation | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.schema === BASELINE_PROCESS_INCARNATION_SCHEMA
    && typeof record.bootSessionId === "string"
    && record.bootSessionId.length > 0
    && typeof record.processStartId === "string"
    && record.processStartId.length > 0
    ? record as unknown as BaselineProcessIncarnation
    : undefined;
}

/** The owned-record branch of packages/agent-app/src/owner-private-lock.ts:340-347 at a3cb9a611. */
export function baselineOwnerRecord(
  content: string,
  schemaTag: string,
  validateOwnerFields?: (record: Readonly<Record<string, unknown>>) => boolean,
): { readonly pid: number; readonly incarnation: BaselineProcessIncarnation } | undefined {
  const record = JSON.parse(content) as Readonly<Record<string, unknown>>;
  const incarnation = baselineProcessIncarnationFromJson(record.incarnation);
  if (record.schema === schemaTag && positivePid(record.pid)
    && typeof record.token === "string" && record.token.length > 0 && record.token.length <= 256
    && typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt))
    && incarnation !== undefined && (validateOwnerFields?.(record) ?? true)) {
    return { pid: record.pid, incarnation };
  }
  return undefined;
}

/** The owner record built by packages/agent-app/src/owner-private-lock.ts:115-122 at a3cb9a611. */
export function baselineOwnerRecordBytes(input: {
  readonly ownerFields?: Readonly<Record<string, unknown>>;
  readonly schemaTag: string;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
  readonly incarnation: BaselineProcessIncarnation;
}): string {
  const base = {
    schema: input.schemaTag, pid: input.pid, token: input.token, createdAt: input.createdAt, incarnation: input.incarnation,
  };
  return `${JSON.stringify({ ...input.ownerFields, ...base })}\n`;
}

/** The lease branch of parseState in packages/agent-app/src/web-request-coordinator.ts:213-216 at a3cb9a611. */
export function baselineWebLeaseAccepted(lease: Readonly<Record<string, unknown>>): boolean {
  return !(!lease || typeof lease.id !== "string" || !Number.isSafeInteger(lease.pid) || (lease.pid as number) <= 0
    || !Number.isSafeInteger(lease.expiresAt) || !baselineProcessIncarnationFromJson(lease.incarnation));
}

function positivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The incarnation fields of the ProcessJobs record check, packages/agent-app/src/process-jobs-store.ts:1301-1302 at a3cb9a611. */
export function baselineProcessJobIncarnationsAccepted(value: Readonly<Record<string, unknown>>): boolean {
  return !(baselineProcessIncarnationFromJson(value.agentIncarnation) === undefined
    || (value.processIncarnation !== undefined && baselineProcessIncarnationFromJson(value.processIncarnation) === undefined));
}

/** `incarnation()` in packages/agent-app/src/subagent-execution-ownership.ts:120-122 at a3cb9a611. */
export function baselineSubagentIncarnationAccepted(value: unknown): boolean {
  return object(value) && exact(value, ["schema", "bootSessionId", "processStartId"])
    && value.schema === "mono-agent.process-incarnation.v1" && text(value.bootSessionId, 256) && text(value.processStartId, 256);
}

function text(value: unknown, bytes: number): value is string { return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= bytes; }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
