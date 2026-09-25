import type { Bullet } from "./types.js";

const PREFIX = "label:v1:";
const ENTITY_ID = /^[a-z][a-z0-9-]{0,31}:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const KEY = /^(?:birth_date|full_name|preferred_name|relationship|home_location|work_location|other:[a-z](?:[a-z0-9]|-[a-z0-9]){0,31})$/u;
export const MEMORY_RELATIONSHIP_ROLES = ["parent", "child", "partner", "spouse", "sibling", "friend", "colleague", "other"] as const;
const ATTRIBUTIONS = ["user-stated", "document", "assistant-inferred", "unknown"] as const;
type Attribution = typeof ATTRIBUTIONS[number];
type FactValue = { readonly type: "date"; readonly date: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "entity"; readonly entityId: string }
  | { readonly type: "relationship"; readonly role: typeof MEMORY_RELATIONSHIP_ROLES[number]; readonly targetEntityId: string };
export type MemoryLabel =
  | { readonly v: 1; readonly kind: "fact"; readonly entityId: string; readonly key: string;
      readonly value: FactValue; readonly attribution: Attribution; readonly validFrom?: string; readonly validTo?: string }
  | { readonly v: 1; readonly kind: "preference"; readonly scope: string; readonly attribution: Attribution }
  | { readonly v: 1; readonly kind: "lesson"; readonly scope: string; readonly verified: boolean };

function fail(): never { throw new Error("memory-bujo: invalid label in bullet metadata."); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && [...value].length > 0 && [...value].length <= max
    && value.trim() === value && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}
function entity(value: unknown): value is string {
  return typeof value === "string" && value.length <= 96 && ENTITY_ID.test(value);
}
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(`${value}T`);
}
function scope(value: unknown): value is string {
  if (value === "agent") return true;
  if (typeof value !== "string" || value.length > 128) return false;
  const match = /^(project|user|conversation):(.+)$/u.exec(value);
  return match !== null && safeText(match[2], 96) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(match[2]!);
}
function valueFor(value: unknown, key: string): boolean {
  if (!object(value)) return false;
  if (key === "birth_date") return keys(value, ["type", "date"]) && value.type === "date" && date(value.date);
  if (key === "relationship") return keys(value, ["type", "role", "targetEntityId"])
    && value.type === "relationship" && MEMORY_RELATIONSHIP_ROLES.includes(value.role as typeof MEMORY_RELATIONSHIP_ROLES[number])
    && entity(value.targetEntityId) && (value.targetEntityId as string).startsWith("person:");
  if (value.type === "text") return keys(value, ["type", "text"]) && safeText(value.text, 160);
  if (!key.startsWith("other:")) return false;
  if (value.type === "date") return keys(value, ["type", "date"]) && date(value.date);
  return keys(value, ["type", "entityId"]) && value.type === "entity" && entity(value.entityId);
}
export function validateMemoryLabel(value: unknown): MemoryLabel {
  if (!object(value) || value.v !== 1) return fail();
  if (value.kind === "fact") {
    if (!keys(value, ["v", "kind", "entityId", "key", "value", "attribution"], ["validFrom", "validTo"])
      || !entity(value.entityId) || !(value.entityId as string).startsWith("person:")
      || typeof value.key !== "string" || !KEY.test(value.key) || !valueFor(value.value, value.key)
      || !ATTRIBUTIONS.includes(value.attribution as Attribution)
      || (value.validFrom !== undefined && !date(value.validFrom))
      || (value.validTo !== undefined && !date(value.validTo))
      || (value.validFrom !== undefined && value.validTo !== undefined && value.validFrom > value.validTo)
      || (object(value.value) && value.value.type === "relationship" && value.value.targetEntityId === value.entityId)) return fail();
  } else if (value.kind === "preference") {
    if (!keys(value, ["v", "kind", "scope", "attribution"]) || !scope(value.scope)
      || !ATTRIBUTIONS.includes(value.attribution as Attribution)) return fail();
  } else if (value.kind === "lesson") {
    if (!keys(value, ["v", "kind", "scope", "verified"]) || !scope(value.scope)
      || typeof value.verified !== "boolean") return fail();
  } else return fail();
  return value as unknown as MemoryLabel;
}
export function canonicalMemoryLabel(label: MemoryLabel): string {
  return canonical(validateMemoryLabel(label));
}

/** Read damaged canonical refs without losing the enclosing bullet or healthy labels. */
export function readableLabelsOf(bullet: Pick<Bullet, "refs">): readonly MemoryLabel[] {
  const seen = new Set<string>();
  const labels: MemoryLabel[] = [];
  for (const ref of bullet.refs) {
    if (!ref.startsWith("label:")) continue;
    try {
      const [label] = labelsOf({ refs: [ref] });
      if (label !== undefined && !seen.has(ref) && labels.length < 8) {
        seen.add(ref);
        labels.push(label);
      }
    } catch { /* The audit diagnoses invalid source refs; reads retain the bullet. */ }
  }
  return labels;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function encodeMemoryLabel(label: MemoryLabel): string {
  const payload = Buffer.from(canonical(validateMemoryLabel(label)), "utf8");
  if (payload.length > 768) return fail();
  return `${PREFIX}${payload.toString("base64url")}`;
}
export function labelsOf(bullet: Pick<Bullet, "refs">): readonly MemoryLabel[] {
  const labels: MemoryLabel[] = [];
  const seen = new Set<string>();
  for (const ref of bullet.refs) {
    if (!ref.startsWith("label:")) continue;
    if (!ref.startsWith(PREFIX)) return fail();
    const encoded = ref.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length > 1024) return fail();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded || bytes.toString("utf8").includes("\ufffd")) return fail();
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return fail(); }
    const label = validateMemoryLabel(parsed);
    if (canonical(label) !== bytes.toString("utf8") || seen.has(encoded)) return fail();
    seen.add(encoded);
    labels.push(label);
    if (labels.length > 8) return fail();
  }
  return labels;
}
export function withMemoryLabels(bullet: Bullet, labels: readonly MemoryLabel[]): Bullet {
  if (labels.length > 8) return fail();
  const refs = bullet.refs.filter((ref) => !ref.startsWith("label:"));
  // Validate pre-existing labels before replacing them; never repair malformed metadata silently.
  labelsOf(bullet);
  const result = { ...bullet, refs: [...refs, ...labels.map(encodeMemoryLabel)] };
  if (result.refs.length > 64) return fail();
  labelsOf(result);
  return result;
}
export function assertMemoryLabelScope(value: string): void { if (!scope(value)) fail(); }
export function assertMemoryLabelEntity(value: string): void {
  if (!entity(value) || !value.startsWith("person:")) fail();
}
export function assertMemoryLabelDate(value: string): void { if (!date(value)) fail(); }
