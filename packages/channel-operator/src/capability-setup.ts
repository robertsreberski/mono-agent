/** Operator-specific read-only discovery. No config, credentials, or write authority. */
export type CapabilityStatus = "ok" | "waiting" | "disabled" | "error";
export interface CapabilityEvidence {
  readonly id: string;
  readonly status: CapabilityStatus;
}
export interface CapabilityChoice {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly requirements: readonly string[];
  readonly usage: string;
  readonly ownedConfigPaths: readonly string[];
  /** Static instructions and example fragments, never current config values. */
  readonly steps: readonly string[];
  readonly status: CapabilityStatus;
}
export interface CapabilityCard extends CapabilityChoice {
  readonly evidence: readonly CapabilityEvidence[];
  readonly selectedVariant?: string;
  readonly variants?: readonly CapabilityChoice[];
}
export interface CapabilitySetupSnapshot {
  readonly version: 1;
  readonly observedAt: string;
  readonly process: { readonly pid: number; readonly startedAt: string };
  /** Validation reads configured input paths with this process's environment, not a reloaded runtime. */
  readonly observation: "durable-inputs" | "loaded-snapshot";
  readonly cards: readonly CapabilityCard[];
  /** Optional projection supplied by a separate host-preflight owner. Never inferred. */
  readonly hostPreflight?: {
    readonly schemaVersion: 1;
    readonly operation: "host-preflight";
    readonly checks: readonly CapabilityEvidence[];
  };
}
export interface CapabilitySetupService {
  read(): Promise<CapabilitySetupSnapshot>;
}
export const MAX_CAPABILITY_SETUP_BYTES = 128 * 1024;

/** Strict bounded decoder used on both sides of the operator boundary. */
export function parseCapabilitySetupSnapshot(value: unknown): CapabilitySetupSnapshot {
  const object = (v: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (v === null || typeof v !== "object" || Array.isArray(v)
      || Object.keys(v).some((key) => !keys.includes(key))) throw new Error("Invalid capability report.");
    return v as Record<string, unknown>;
  };
  const text = (v: unknown, max = 8192): string => {
    if (typeof v !== "string" || v.length === 0 || v.length > max) throw new Error("Invalid capability text.");
    return v;
  };
  const status = (v: unknown): CapabilityStatus => {
    if (v !== "ok" && v !== "waiting" && v !== "disabled" && v !== "error") throw new Error("Invalid capability status.");
    return v;
  };
  const list = <T>(v: unknown, max: number, parse: (v: unknown) => T): T[] => {
    if (!Array.isArray(v) || v.length > max) throw new Error("Invalid capability list.");
    return v.map(parse);
  };
  const evidence = (v: unknown): CapabilityEvidence => {
    const r = object(v, ["id", "status"]);
    return { id: text(r.id, 128), status: status(r.status) };
  };
  const choiceKeys = ["id", "title", "purpose", "requirements", "usage", "ownedConfigPaths", "steps", "status"];
  const choice = (r: Record<string, unknown>): CapabilityChoice => ({
    id: text(r.id, 128), title: text(r.title, 256), purpose: text(r.purpose),
    requirements: list(r.requirements, 20, (v) => text(v)), usage: text(r.usage),
    ownedConfigPaths: list(r.ownedConfigPaths, 30, (v) => text(v, 256)),
    steps: list(r.steps, 20, (v) => text(v)), status: status(r.status),
  });
  const r = object(value, ["version", "observedAt", "process", "observation", "cards", "hostPreflight"]);
  const process = object(r.process, ["pid", "startedAt"]);
  const date = (v: unknown): string => {
    const s = text(v, 64);
    if (!Number.isFinite(Date.parse(s))) throw new Error("Invalid capability time.");
    return s;
  };
  if (r.version !== 1 || (r.observation !== "durable-inputs" && r.observation !== "loaded-snapshot")
    || !Number.isSafeInteger(process.pid) || Number(process.pid) <= 0) throw new Error("Invalid capability report.");
  const cards = list(r.cards, 12, (v): CapabilityCard => {
    const card = object(v, [...choiceKeys, "evidence", "selectedVariant", "variants"]);
    return {
      ...choice(card), evidence: list(card.evidence, 20, evidence),
      ...(card.selectedVariant === undefined ? {} : { selectedVariant: text(card.selectedVariant, 128) }),
      ...(card.variants === undefined ? {} : { variants: list(card.variants, 4, (v) => choice(object(v, choiceKeys))) }),
    };
  });
  let hostPreflight: CapabilitySetupSnapshot["hostPreflight"];
  if (r.hostPreflight !== undefined) {
    const host = object(r.hostPreflight, ["schemaVersion", "operation", "checks"]);
    if (host.schemaVersion !== 1 || host.operation !== "host-preflight") throw new Error("Invalid host-preflight projection.");
    hostPreflight = { schemaVersion: 1, operation: "host-preflight", checks: list(host.checks, 16, evidence) };
  }
  const result: CapabilitySetupSnapshot = {
    version: 1, observedAt: date(r.observedAt), process: { pid: Number(process.pid), startedAt: date(process.startedAt) },
    observation: r.observation, cards, ...(hostPreflight === undefined ? {} : { hostPreflight }),
  };
  if (JSON.stringify(result).length > MAX_CAPABILITY_SETUP_BYTES / 3) {
    // UTF-8 is at most three bytes per UTF-16 code unit; conservative portable bound.
    throw new Error("Capability report is too large.");
  }
  return result;
}
