import type { MemoryLabel } from "../bujo/labels.js";
import { assertMemoryLabelDate, assertMemoryLabelEntity, assertMemoryLabelScope, canonicalMemoryLabel, validateMemoryLabel } from "../bujo/labels.js";
import { MemoryDbGraph } from "./db-graph.js";

export interface IndexedMemoryLabel {
  readonly memoryId: string;
  readonly ordinal: number;
  readonly label: MemoryLabel;
}
export interface MemoryLabelHit extends IndexedMemoryLabel {
  readonly text: string;
  readonly status: string;
  readonly sourceFile?: string;
  readonly sourceLine?: number;
  readonly createdAt: string;
  readonly active: boolean;
  readonly conflict: boolean;
  readonly currentAt?: boolean;
}
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Canonical daily lines own labels; this table is only their queryable projection. */
export class MemoryDbLabels extends MemoryDbGraph {
  replaceMemoryLabels(memoryId: string, labels: readonly MemoryLabel[]): void {
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM memories WHERE id = ?").get(memoryId)) {
        throw new Error("memory-store: label projection has no memory endpoint.");
      }
      this.db.prepare("DELETE FROM memory_labels WHERE memory_id = ?").run(memoryId);
      const insert = this.db.prepare(`INSERT INTO memory_labels
        (memory_id, ordinal, kind, entity_id, scope, payload) VALUES (?, ?, ?, ?, ?, ?)`);
      labels.forEach((input, ordinal) => {
        const label = validateMemoryLabel(input);
        insert.run(memoryId, ordinal, label.kind, label.kind === "fact" ? label.entityId : null,
          label.kind === "fact" ? null : label.scope, canonicalMemoryLabel(label));
      });
    })();
  }

  replaceLabelProjection(rows: readonly IndexedMemoryLabel[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_labels").run();
      const insert = this.db.prepare(`INSERT INTO memory_labels
        (memory_id, ordinal, kind, entity_id, scope, payload) VALUES (?, ?, ?, ?, ?, ?)`);
      const hasMemory = this.db.prepare("SELECT 1 FROM memories WHERE id = ?");
      for (const row of rows) {
        if (!hasMemory.get(row.memoryId)) throw new Error("memory-store: label projection has no memory endpoint.");
        const label = validateMemoryLabel(row.label);
        insert.run(row.memoryId, row.ordinal, label.kind, label.kind === "fact" ? label.entityId : null,
          label.kind === "fact" ? null : label.scope, canonicalMemoryLabel(label));
      }
    })();
  }

  labelProjection(): readonly IndexedMemoryLabel[] {
    if (!this.tableExists("memory_labels")) return [];
    const rows = this.db.prepare(`SELECT memory_id AS memoryId, ordinal, payload FROM memory_labels
      ORDER BY memory_id COLLATE BINARY, ordinal`).all() as Array<{ memoryId: string; ordinal: number; payload: string }>;
    return rows.map((row) => ({ memoryId: row.memoryId, ordinal: row.ordinal,
      label: validateMemoryLabel(JSON.parse(row.payload) as unknown) }));
  }

  labelsForEntity(entityId: string, asOfDate?: string): readonly MemoryLabelHit[] {
    assertMemoryLabelEntity(entityId);
    if (asOfDate !== undefined) assertMemoryLabelDate(asOfDate);
    const hits = this.labelHits("entity_id = ?", [entityId]);
    const active = hits.filter((hit) => hit.active && hit.label.kind === "fact");
    return hits.map((hit) => {
      const label = hit.label;
      if (label.kind !== "fact") throw new Error("memory-store: inconsistent fact label projection.");
      const exclusive = label.key !== undefined
        && ["birth_date", "full_name", "preferred_name", "home_location", "work_location"].includes(label.key);
      const conflict = exclusive && hit.active && active.some((other) => {
        const otherLabel = other.label;
        return otherLabel.kind === "fact" && (other.memoryId !== hit.memoryId || other.ordinal !== hit.ordinal)
          && otherLabel.key === label.key && JSON.stringify(otherLabel.value) !== JSON.stringify(label.value)
          && (label.key !== "home_location" && label.key !== "work_location"
            || ((label.validFrom === undefined || otherLabel.validTo === undefined || label.validFrom <= otherLabel.validTo)
              && (otherLabel.validFrom === undefined || label.validTo === undefined || otherLabel.validFrom <= label.validTo)));
      });
      return { ...hit, conflict, ...(asOfDate === undefined ? {} : { currentAt: hit.active
        && (label.validFrom === undefined || label.validFrom <= asOfDate)
        && (label.validTo === undefined || asOfDate <= label.validTo) }) };
    });
  }

  guidanceForScope(scope: string): readonly MemoryLabelHit[] {
    assertMemoryLabelScope(scope);
    return this.labelHits("scope = ?", [scope]);
  }

  /** Bounded index-only operator inventory; includes inactive labels as history. */
  listLabels(filters: { kind?: MemoryLabel["kind"]; entityId?: string; scope?: string } = {}, limit = 200):
    { hits: readonly MemoryLabelHit[]; truncated: boolean } {
    if (filters.entityId !== undefined) assertMemoryLabelEntity(filters.entityId);
    if (filters.scope !== undefined) assertMemoryLabelScope(filters.scope);
    if (filters.kind !== undefined && !["fact", "preference", "lesson"].includes(filters.kind)) throw new Error("memory-store: invalid label kind.");
    const predicates: string[] = ["memory_id IS NOT NULL"];
    const args: string[] = [];
    for (const [column, value] of [["kind", filters.kind], ["entity_id", filters.entityId], ["scope", filters.scope]] as const) {
      if (value !== undefined) { predicates.push(`${column} = ?`); args.push(value); }
    }
    const cap = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 200;
    const rows = this.labelHits(predicates.join(" AND "), args, cap + 1);
    return { hits: rows.slice(0, cap), truncated: rows.length > cap };
  }

  private labelHits(predicate: string, args: readonly string[], limit?: number): MemoryLabelHit[] {
    if (!this.tableExists("memory_labels")) return [];
    const rows = this.db.prepare(`SELECT l.memory_id AS memoryId, l.ordinal, l.payload,
      m.text, m.status, m.source_file AS sourceFile, m.source_line AS sourceLine, m.created_at AS createdAt
      FROM memory_labels l JOIN memories m ON m.id = l.memory_id WHERE l.${predicate}
      ORDER BY l.memory_id COLLATE BINARY, l.ordinal ${limit === undefined ? "" : "LIMIT ?"}`)
      .all(...args, ...(limit === undefined ? [] : [limit])) as Array<{
        memoryId: string; ordinal: number; payload: string; text: string; status: string;
        sourceFile: string | null; sourceLine: number | null; createdAt: string;
      }>;
    return rows.map((row) => ({ memoryId: row.memoryId, ordinal: row.ordinal,
      label: validateMemoryLabel(JSON.parse(row.payload) as unknown), text: row.text,
      status: row.status, ...(row.sourceFile === null ? {} : { sourceFile: row.sourceFile }),
      ...(row.sourceLine === null ? {} : { sourceLine: row.sourceLine }),
      createdAt: row.createdAt, active: row.status !== "invalidated" && row.status !== "dropped", conflict: false }))
      .sort((a, b) => byteOrder(a.memoryId, b.memoryId) || a.ordinal - b.ordinal);
  }
}
