import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  Entity,
  EntityGraphErrorCode,
  EntityGraphMutationResult,
  EntityGraphStoreOptions,
  EntitySubgraph,
  EntityUpsert,
  Relation,
} from "./types.js";

export class EntityGraphError extends Error {
  readonly code: EntityGraphErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: EntityGraphErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EntityGraphError";
    this.code = code;
    this.details = { ...details, code };
  }
}

interface MutableEntity {
  name: string;
  entityType: string;
  readonly observations: string[];
}

const DEFAULT_ENTITY_TYPE = "unknown";

/**
 * A local, file-first entity graph. Entities, relations, and observations are
 * persisted as JSON Lines using the official MCP memory-server shape so the data
 * stays human- and git-friendly. The whole graph is held in memory and rewritten
 * atomically on each mutation (single-writer; fine well under ~10k entities).
 */
export class JsonlEntityGraphStore {
  private readonly path: string;
  private readonly entities = new Map<string, MutableEntity>();
  private readonly relationKeys = new Set<string>();
  private relations: Relation[] = [];
  private loaded = false;

  constructor(options: EntityGraphStoreOptions) {
    if (typeof options.path !== "string" || options.path.trim().length === 0) {
      throw new EntityGraphError("invalid_graph_options", "Graph path must be a non-empty string.");
    }
    this.path = resolve(options.path);
  }

  async upsertEntities(entities: readonly EntityUpsert[]): Promise<EntityGraphMutationResult> {
    await this.ensureLoaded();
    let upserted = 0;
    let observationsAdded = 0;
    for (const input of entities) {
      const name = requireName(input.name);
      observationsAdded += this.applyEntity(name, input.entityType, input.observations ?? []);
      upserted += 1;
    }
    await this.persist();
    return { entitiesUpserted: upserted, relationsUpserted: 0, observationsAdded };
  }

  async upsertRelations(relations: readonly Relation[]): Promise<EntityGraphMutationResult> {
    await this.ensureLoaded();
    let upserted = 0;
    for (const relation of relations) {
      if (this.applyRelation(relation)) {
        upserted += 1;
      }
    }
    await this.persist();
    return { entitiesUpserted: 0, relationsUpserted: upserted, observationsAdded: 0 };
  }

  async addObservations(name: string, observations: readonly string[]): Promise<EntityGraphMutationResult> {
    await this.ensureLoaded();
    const added = this.applyEntity(requireName(name), undefined, observations);
    await this.persist();
    return { entitiesUpserted: 0, relationsUpserted: 0, observationsAdded: added };
  }

  async deleteEntities(names: readonly string[]): Promise<number> {
    await this.ensureLoaded();
    let removed = 0;
    const keys = new Set(names.map((name) => normalizeName(name)));
    for (const key of keys) {
      if (this.entities.delete(key)) {
        removed += 1;
      }
    }
    if (removed > 0) {
      this.relations = this.relations.filter((relation) => {
        const drop = keys.has(normalizeName(relation.from)) || keys.has(normalizeName(relation.to));
        if (drop) {
          this.relationKeys.delete(relationKey(relation));
        }
        return !drop;
      });
      await this.persist();
    }
    return removed;
  }

  async getEntity(name: string): Promise<Entity | undefined> {
    await this.ensureLoaded();
    const entity = this.entities.get(normalizeName(name));
    return entity === undefined ? undefined : freezeEntity(entity);
  }

  /** Connected subgraph around `name` up to `hops` relation hops (default 1). */
  async getSubgraph(name: string, hops = 1): Promise<EntitySubgraph> {
    await this.ensureLoaded();
    const start = normalizeName(name);
    if (!this.entities.has(start)) {
      return { entities: [], relations: [] };
    }

    const maxHops = Number.isInteger(hops) && hops >= 0 ? hops : 1;
    const visited = new Set<string>([start]);
    const collectedRelations = new Map<string, Relation>();
    let frontier = [start];

    for (let depth = 0; depth < maxHops && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const relation of this.relations) {
          const from = normalizeName(relation.from);
          const to = normalizeName(relation.to);
          if (from !== node && to !== node) {
            continue;
          }
          collectedRelations.set(relationKey(relation), relation);
          const other = from === node ? to : from;
          if (!visited.has(other) && this.entities.has(other)) {
            visited.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }

    const entities: Entity[] = [];
    for (const key of visited) {
      const entity = this.entities.get(key);
      if (entity !== undefined) {
        entities.push(freezeEntity(entity));
      }
    }
    return { entities, relations: [...collectedRelations.values()] };
  }

  /** Keyword search over entity names, types, and observation text. */
  async search(query: string, limit = 10): Promise<readonly Entity[]> {
    await this.ensureLoaded();
    const tokens = query.toLowerCase().split(/\s+/u).map((token) => token.trim()).filter(Boolean);
    if (tokens.length === 0) {
      return [];
    }
    const scored: Array<{ entity: MutableEntity; score: number }> = [];
    for (const entity of this.entities.values()) {
      const haystack = `${entity.name}\n${entity.entityType}\n${entity.observations.join("\n")}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += 1;
        }
      }
      if (score > 0) {
        scored.push({ entity, score });
      }
    }
    scored.sort((a, b) => b.score - a.score || b.entity.observations.length - a.entity.observations.length);
    return scored.slice(0, Math.max(0, limit)).map((entry) => freezeEntity(entry.entity));
  }

  /** Full graph snapshot. */
  async snapshot(): Promise<EntitySubgraph> {
    await this.ensureLoaded();
    return {
      entities: [...this.entities.values()].map(freezeEntity),
      relations: [...this.relations],
    };
  }

  /**
   * Compact markdown digest of the most salient entities (by observation count),
   * suitable for folding into the always-in-context block. Empty when the graph
   * has no entities.
   */
  async digest(limit = 12): Promise<string> {
    await this.ensureLoaded();
    const ranked = [...this.entities.values()]
      .sort((a, b) => b.observations.length - a.observations.length || a.name.localeCompare(b.name))
      .slice(0, Math.max(0, limit));
    if (ranked.length === 0) {
      return "";
    }
    return ranked
      .map((entity) => {
        const facts = entity.observations.slice(0, 4).join("; ");
        return facts.length === 0
          ? `- ${entity.name} (${entity.entityType})`
          : `- ${entity.name} (${entity.entityType}): ${facts}`;
      })
      .join("\n");
  }

  private applyEntity(name: string, entityType: string | undefined, observations: readonly string[]): number {
    const key = normalizeName(name);
    let entity = this.entities.get(key);
    if (entity === undefined) {
      entity = { name, entityType: normalizeType(entityType) ?? DEFAULT_ENTITY_TYPE, observations: [] };
      this.entities.set(key, entity);
    } else if (entityType !== undefined) {
      const normalizedType = normalizeType(entityType);
      if (normalizedType !== undefined) {
        entity.entityType = normalizedType;
      }
    }

    let added = 0;
    for (const raw of observations) {
      const observation = normalizeObservation(raw);
      if (observation !== undefined && !entity.observations.includes(observation)) {
        entity.observations.push(observation);
        added += 1;
      }
    }
    return added;
  }

  private applyRelation(relation: Relation): boolean {
    const from = requireName(relation.from);
    const to = requireName(relation.to);
    const relationType = requireRelationType(relation.relationType);
    const normalized: Relation = { from, to, relationType };
    const key = relationKey(normalized);
    if (this.relationKeys.has(key)) {
      return false;
    }
    // Endpoints must exist for traversal; auto-create lightweight stubs if absent.
    this.applyEntity(from, undefined, []);
    this.applyEntity(to, undefined, []);
    this.relationKeys.add(key);
    this.relations.push(normalized);
    return true;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        this.loaded = true;
        return;
      }
      throw new EntityGraphError("graph_read_failed", "Unable to read graph file.", {
        path: this.path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const lines = raw.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? "";
      if (line.length === 0) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new EntityGraphError("graph_read_failed", `Malformed JSON on graph line ${index + 1}.`, {
          path: this.path,
          line: index + 1,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      this.ingestRecord(record, index + 1);
    }
    this.loaded = true;
  }

  private ingestRecord(record: unknown, line: number): void {
    if (typeof record !== "object" || record === null) {
      throw new EntityGraphError("graph_read_failed", `Graph line ${line} is not an object.`, { path: this.path, line });
    }
    const value = record as Record<string, unknown>;
    if (value.type === "entity") {
      const name = requireString(value.name, "entity.name", line);
      const entityType = typeof value.entityType === "string" ? value.entityType : DEFAULT_ENTITY_TYPE;
      const observations = Array.isArray(value.observations)
        ? value.observations.filter((item): item is string => typeof item === "string")
        : [];
      this.applyEntity(name, entityType, observations);
      return;
    }
    if (value.type === "relation") {
      this.applyRelation({
        from: requireString(value.from, "relation.from", line),
        to: requireString(value.to, "relation.to", line),
        relationType: requireString(value.relationType, "relation.relationType", line),
      });
      return;
    }
    throw new EntityGraphError("graph_read_failed", `Graph line ${line} has unknown record type.`, {
      path: this.path,
      line,
      recordType: value.type,
    });
  }

  private async persist(): Promise<void> {
    const lines: string[] = [];
    for (const entity of this.entities.values()) {
      lines.push(JSON.stringify({
        type: "entity",
        name: entity.name,
        entityType: entity.entityType,
        observations: entity.observations,
      }));
    }
    for (const relation of this.relations) {
      lines.push(JSON.stringify({
        type: "relation",
        from: relation.from,
        to: relation.to,
        relationType: relation.relationType,
      }));
    }
    const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    const tmpPath = `${this.path}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmpPath, body, "utf8");
      await rename(tmpPath, this.path);
    } catch (error) {
      throw new EntityGraphError("graph_write_failed", "Unable to write graph file.", {
        path: this.path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createEntityGraphStore(options: EntityGraphStoreOptions): JsonlEntityGraphStore {
  return new JsonlEntityGraphStore(options);
}

/** Normalized identity key for an entity name: lowercased, whitespace-collapsed. */
export function normalizeName(name: string): string {
  return name.replace(/\s+/gu, " ").trim().toLowerCase();
}

function freezeEntity(entity: MutableEntity): Entity {
  return { name: entity.name, entityType: entity.entityType, observations: [...entity.observations] };
}

function relationKey(relation: Relation): string {
  return `${normalizeName(relation.from)} ${normalizeName(relation.to)} ${relation.relationType.trim().toLowerCase()}`;
}

function requireName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new EntityGraphError("invalid_graph_input", "Entity name must be a non-empty string.");
  }
  return name.replace(/\s+/gu, " ").trim();
}

function requireRelationType(relationType: unknown): string {
  if (typeof relationType !== "string" || relationType.trim().length === 0) {
    throw new EntityGraphError("invalid_graph_input", "Relation type must be a non-empty string.");
  }
  return relationType.trim();
}

function normalizeType(entityType: string | undefined): string | undefined {
  if (entityType === undefined) {
    return undefined;
  }
  const normalized = entityType.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeObservation(observation: string): string | undefined {
  if (typeof observation !== "string") {
    return undefined;
  }
  const normalized = observation.replace(/\r\n?/gu, "\n").trim();
  return normalized.length === 0 ? undefined : normalized;
}

function requireString(value: unknown, field: string, line: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EntityGraphError("graph_read_failed", `Graph line ${line} field ${field} must be a non-empty string.`, { line, field });
  }
  return value.trim();
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code;
}
