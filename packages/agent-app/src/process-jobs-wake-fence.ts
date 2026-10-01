/** Owner-private v1 admission proof. Never included in process-job projections. */
export interface WakeAttemptFence {
  readonly version: 1;
  readonly token: string;
  state: "not_crossed" | "crossed" | "fenced";
  boundary?: string;
}
export interface WakeRecovery {
  readonly version: 1;
  readonly token: string;
  readonly notCrossed: readonly string[];
}
export const MAX_WAKE_CERTIFICATES = 16;
export function validWakeToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
}
export function validWakeFence(value: unknown): value is WakeAttemptFence {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && validWakeToken(record.token)
    && ["not_crossed", "crossed", "fenced"].includes(String(record.state))
    && (record.state === "crossed" ? validWakeToken(record.boundary) : record.boundary === undefined)
    && Object.keys(record).every((key) => ["version", "token", "state", "boundary"].includes(key));
}
export function validWakeCertificates(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_WAKE_CERTIFICATES
    && value.every(validWakeToken) && new Set(value).size === value.length;
}
