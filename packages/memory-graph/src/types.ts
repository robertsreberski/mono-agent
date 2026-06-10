export type EntityGraphErrorCode =
  | "invalid_graph_options"
  | "invalid_graph_input"
  | "graph_read_failed"
  | "graph_write_failed";

export interface Entity {
  readonly name: string;
  readonly entityType: string;
  readonly observations: readonly string[];
}

export interface Relation {
  readonly from: string;
  readonly to: string;
  readonly relationType: string;
}

export interface EntitySubgraph {
  readonly entities: readonly Entity[];
  readonly relations: readonly Relation[];
}

/** Partial entity used for create-or-merge upserts. */
export interface EntityUpsert {
  readonly name: string;
  readonly entityType?: string;
  readonly observations?: readonly string[];
}

export interface EntityGraphStoreOptions {
  /** Path to the JSON Lines graph file (e.g. `<memoryRoot>/graph.jsonl`). */
  readonly path: string;
}

export interface EntityGraphMutationResult {
  readonly entitiesUpserted: number;
  readonly relationsUpserted: number;
  readonly observationsAdded: number;
}
