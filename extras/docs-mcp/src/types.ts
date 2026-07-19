export type MonoAgentDocsScope = "all" | "composer" | "docs";

export interface MonoAgentDocsSearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly scope?: MonoAgentDocsScope;
}

export interface MonoAgentDocsSearchHit {
  readonly rank: number;
  readonly chunkId: string;
  readonly uri: string;
  readonly source: "composer" | "docs";
  readonly path: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly canonicalUrl?: string;
  readonly text: string;
}

export interface MonoAgentDocsSearchResult {
  readonly schema: "mono-agent.docs-search.v1";
  readonly docsVersion: string;
  readonly corpusDigest: string;
  readonly retrievalMode: "hybrid";
  readonly results: readonly MonoAgentDocsSearchHit[];
}
