import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { docsMcpPackageVersion } from "./package-version.js";
import { loadDefaultDocsSearchIndex } from "./search.js";
import type { MonoAgentDocsSearchHit, MonoAgentDocsSearchResult } from "./types.js";

export const MONO_AGENT_DOCS_TOOL_NAME = "search_mono_agent_docs";

const searchInputSchema = {
  query: z.string().min(3).max(500).describe("Natural-language question or exact mono-agent config, package, environment, or CLI identifier."),
  limit: z.number().int().min(1).max(8).default(5).describe("Maximum number of documentation chunks to return."),
  scope: z.enum(["all", "composer", "docs"]).default("all").describe("Search all sources, authoritative composer references, or long-form public documentation."),
};

const searchHitSchema = z.object({
  rank: z.number().int().positive(),
  chunkId: z.string(),
  uri: z.string(),
  source: z.enum(["composer", "docs"]),
  path: z.string(),
  title: z.string(),
  headingPath: z.array(z.string()),
  canonicalUrl: z.string().optional(),
  text: z.string(),
});

const searchOutputSchema = {
  schema: z.literal("mono-agent.docs-search.v1"),
  docsVersion: z.string(),
  corpusDigest: z.string(),
  retrievalMode: z.literal("hybrid"),
  results: z.array(searchHitSchema),
};

export function createMonoAgentDocsMcpServer(): McpServer {
  const server = new McpServer({ name: "mono-agent-docs", version: docsMcpPackageVersion() });
  server.registerTool(
    MONO_AGENT_DOCS_TOOL_NAME,
    {
      title: "Search mono-agent documentation",
      description: "Semantically and lexically search the version-matched mono-agent documentation. Returns complete Markdown excerpts, not link-only results. Prefer scope=composer for configuration and capability questions.",
      inputSchema: searchInputSchema,
      outputSchema: searchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit, scope }) => {
      const index = await loadDefaultDocsSearchIndex();
      const result = await index.search({ query, limit, scope });
      return {
        content: searchResultContent(result),
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerResource(
    "mono-agent-documentation-chunk",
    new ResourceTemplate("mono-agent-docs://chunk/{chunkId}", { list: undefined }),
    {
      title: "Mono-agent documentation chunk",
      description: "An exact versioned Markdown excerpt returned by search_mono_agent_docs.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const chunkId = String(variables.chunkId ?? "");
      const index = await loadDefaultDocsSearchIndex();
      const chunk = index.getChunk(chunkId);
      if (chunk === undefined) {
        throw new Error(`Unknown mono-agent documentation chunk ${chunkId}.`);
      }
      const text = formatChunk(chunk);
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text }],
      };
    },
  );
  return server;
}

function searchResultContent(result: MonoAgentDocsSearchResult): Array<
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resource_link"; readonly uri: string; readonly name: string; readonly description: string; readonly mimeType: string }
> {
  const fullText = result.results.length === 0
    ? `No mono-agent documentation matched this query (docs version ${result.docsVersion}).`
    : [
        `Mono-agent documentation search (${result.retrievalMode}, docs version ${result.docsVersion}):`,
        ...result.results.map((hit) => formatSearchHit(hit)),
      ].join("\n\n");
  return [
    { type: "text", text: fullText },
    ...result.results.map((hit) => ({
      type: "resource_link" as const,
      uri: hit.uri,
      name: `${hit.title}: ${hit.headingPath.join(" > ") || "Overview"}`,
      description: `Rank ${hit.rank} excerpt from ${hit.path}`,
      mimeType: "text/markdown",
    })),
  ];
}

function formatSearchHit(hit: MonoAgentDocsSearchHit): string {
  const heading = hit.headingPath.length === 0 ? "Overview" : hit.headingPath.join(" > ");
  return `## ${hit.rank}. ${hit.title}\n\nSource: ${hit.path}\nHeading: ${heading}\nResource: ${hit.uri}\n\n${hit.text}`;
}

function formatChunk(chunk: {
  readonly title: string;
  readonly path: string;
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly canonicalUrl?: string;
}): string {
  return [
    `# ${chunk.title}`,
    `Source: ${chunk.path}`,
    `Heading: ${chunk.headingPath.join(" > ") || "Overview"}`,
    ...(chunk.canonicalUrl === undefined ? [] : [`Canonical URL: ${chunk.canonicalUrl}`]),
    "",
    chunk.text,
  ].join("\n");
}
