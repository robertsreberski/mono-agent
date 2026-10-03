/** Private authenticated agent-to-web ingress metadata, not a browser DTO. */
export interface ProcessJobWakeRecovery {
  readonly version: 1;
  readonly token: string;
  readonly notCrossed: readonly string[];
}
export function validProcessJobWakeRecovery(value: unknown): value is ProcessJobWakeRecovery {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const token = (item: unknown): item is string => typeof item === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(item);
  return record.version === 1 && token(record.token) && Array.isArray(record.notCrossed)
    && record.notCrossed.length <= 16 && record.notCrossed.every(token)
    && !record.notCrossed.includes(record.token)
    && new Set(record.notCrossed).size === record.notCrossed.length
    && Object.keys(record).length === 3;
}
