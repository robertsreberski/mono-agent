import type { MemoryStatus, MemoryType } from "@mono-agent/memory-store";

import type { Bullet } from "./types.js";

const MARKERS: Record<string, { type: MemoryType; status: MemoryStatus }> = {
  "[ ]": { type: "task", status: "open" },
  "[x]": { type: "task", status: "done" },
  "[>]": { type: "task", status: "migrated" },
  "[<]": { type: "task", status: "scheduled" },
  "[~]": { type: "task", status: "dropped" },
  "◦": { type: "event", status: "open" },
  "–": { type: "note", status: "open" },
};

const STATUS_MARKER: Partial<Record<MemoryStatus, string>> = {
  done: "[x]",
  migrated: "[>]",
  scheduled: "[<]",
  dropped: "[~]",
  invalidated: "[~]", // rendered struck like dropped; the comment metadata stays authoritative for the real status
};

const MARKER_FOR = (type: MemoryType, status: MemoryStatus): string => {
  // For task-style statuses (done/migrated/scheduled/dropped), the visible marker encodes status.
  const statusMarker = STATUS_MARKER[status];
  if (statusMarker !== undefined) return statusMarker;
  // For open status, use the type-specific marker.
  for (const [marker, m] of Object.entries(MARKERS)) {
    if (m.type === type && m.status === status) return marker;
  }
  // notes/events that have no direct marker fall back to the base marker
  if (type === "event") return "◦";
  return "–";
};

const LINE_RE = /^- (\[[ x><~]\]|◦|–) (.*?)  <!--mem (.*)-->$/u;

export function parseBullet(line: string): Bullet | undefined {
  const match = LINE_RE.exec(line);
  if (match === null) return undefined;
  const [, marker, text, meta] = match;
  const fields = parseMeta(meta ?? "");
  const base = MARKERS[marker ?? ""];
  if (base === undefined) return undefined;
  // `||` (not `??`) so an empty metadata value (e.g. `status=`) also falls back to the marker-derived value.
  const status = (fields.status as MemoryStatus | undefined) || base.status;
  const type = (fields.type as MemoryType | undefined) || base.type;
  const salienceNum = Number(fields.salience);
  const bullet: Bullet = {
    id: fields.id ?? "",
    type,
    status,
    text: text ?? "",
    salience: fields.salience !== undefined && Number.isFinite(salienceNum) ? salienceNum : 0.5,
    isInsight: fields.isInsight === "1",
    createdAt: fields.created ?? "",
    refs: fields.refs === undefined || fields.refs.length === 0 ? [] : fields.refs.split(","),
    ...(fields.due !== undefined ? { dueAt: fields.due } : {}),
  };
  return bullet;
}

export function serializeBullet(bullet: Bullet): string {
  if (bullet.text.includes("\n") || bullet.text.includes("<!--mem")) {
    throw new Error("memory-bujo: bullet text must not contain a newline or the '<!--mem' delimiter.");
  }
  const marker = MARKER_FOR(bullet.type, bullet.status);
  const meta = [
    `id=${bullet.id}`,
    `type=${bullet.type}`,
    `status=${bullet.status}`,
    `salience=${bullet.salience}`,
    `isInsight=${bullet.isInsight ? "1" : "0"}`,
    `created=${bullet.createdAt}`,
    `refs=${bullet.refs.join(",")}`,
    ...(bullet.dueAt === undefined ? [] : [`due=${bullet.dueAt}`]),
  ].join(" ");
  return `- ${marker} ${bullet.text}  <!--mem ${meta}-->`;
}

function parseMeta(meta: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of meta.trim().split(/\s+/u)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export interface DailyFile {
  readonly lines: readonly { readonly raw: string; readonly bullet?: Bullet }[];
}

export function parseDailyFile(content: string): DailyFile & { bullets: Bullet[] } {
  const lines = content.split("\n").map((raw) => {
    const bullet = parseBullet(raw);
    return bullet === undefined ? { raw } : { raw, bullet };
  });
  return { lines, bullets: lines.flatMap((l) => (l.bullet ? [l.bullet] : [])) };
}

export function serializeDailyFile(file: DailyFile): string {
  return file.lines.map((l) => (l.bullet ? serializeBullet(l.bullet) : l.raw)).join("\n");
}
