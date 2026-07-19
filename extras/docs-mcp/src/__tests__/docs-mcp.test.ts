import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadDocsCorpus } from "../corpus.js";
import { MonoAgentDocsSearchIndex } from "../search.js";
import { createMonoAgentDocsMcpServer, MONO_AGENT_DOCS_TOOL_NAME } from "../server.js";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const corpusDir = join(packageRoot, "dist", "corpus");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.sequential("@mono-agent/docs-mcp", () => {
  it("builds a deterministic, checksummed corpus from canonical public sources", async () => {
    const before = await artifactDigests();
    await execFileAsync(process.execPath, [join(packageRoot, "scripts", "generate-corpus.mjs")], { cwd: packageRoot });
    const after = await artifactDigests();
    expect(after).toEqual(before);

    const corpus = await loadDocsCorpus(corpusDir);
    const paths = new Set(corpus.chunks.map((chunk) => chunk.path));
    expect(paths).toContain("composer/SKILL.md");
    expect(paths).toContain("composer/references/feature-coverage.md");
    expect(paths).toContain("docs/reference/feature-matrix.md");
    expect(paths).toContain("docs/tools/documentation-mcp.md");
    expect([...paths].some((path) => path.startsWith("docs/skills/"))).toBe(false);
    expect([...paths].some((path) => path.startsWith("docs/superpowers/"))).toBe(false);
    expect([...paths].some((path) => path.includes("website/"))).toBe(false);
    expect(corpus.chunks.some((chunk) => chunk.text.includes("```json") || chunk.text.includes("```bash"))).toBe(true);
    expect(corpus.manifest.chunkCount).toBe(corpus.chunks.length);
    expect(corpus.manifest.model).toMatchObject({ version: "1.0.4", dimensions: 256 });
  }, 60_000);

  it("fails closed when a generated artifact is corrupt", async () => {
    const copy = await mkdtemp(join(tmpdir(), "mono-agent-docs-corrupt-"));
    temporaryDirectories.push(copy);
    await cp(corpusDir, copy, { recursive: true });
    const path = join(copy, "embeddings.f32");
    const bytes = await readFile(path);
    bytes[0] = bytes[0]! ^ 0xff;
    await writeFile(path, bytes);
    await expect(loadDocsCorpus(copy)).rejects.toThrow(/checksum mismatch/u);
  });

  it("finds paraphrased concepts and exact identifiers with source scoping", async () => {
    const index = new MonoAgentDocsSearchIndex(await loadDocsCorpus(corpusDir));
    const exact = await index.search({ query: "runtime.fallbackModels", scope: "composer", limit: 5 });
    expect(exact.results).toHaveLength(5);
    expect(exact.results.every((result) => result.source === "composer")).toBe(true);
    expect(exact.results.some((result) => /fallback/iu.test(`${result.headingPath.join(" ")} ${result.text}`))).toBe(true);

    const semantic = await index.search({ query: "How can my agent answer people through Telegram?", limit: 5 });
    expect(semantic.results.some((result) => /telegram/iu.test(`${result.title} ${result.headingPath.join(" ")} ${result.text}`))).toBe(true);

    const docsOnly = await index.search({ query: "external Supermemory backend", scope: "docs", limit: 8 });
    expect(docsOnly.results.every((result) => result.source === "docs")).toBe(true);
    expect(docsOnly.results.some((result) => result.path.includes("memory"))).toBe(true);
    const pathCounts = docsOnly.results.reduce((counts, result) => counts.set(result.path, (counts.get(result.path) ?? 0) + 1), new Map<string, number>());
    expect(Math.max(...pathCounts.values())).toBeLessThanOrEqual(2);
  }, 30_000);

  it("publishes the search tool and readable chunk resources over MCP", async () => {
    const server = createMonoAgentDocsMcpServer();
    const client = new Client({ name: "docs-mcp-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toContainEqual(expect.objectContaining({
        name: MONO_AGENT_DOCS_TOOL_NAME,
        annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
      }));
      const response = await client.callTool({
        name: MONO_AGENT_DOCS_TOOL_NAME,
        arguments: { query: "channels.plugins[]", scope: "composer", limit: 3 },
      }) as { content: Array<{ type: string; text?: string; uri?: string }>; structuredContent?: { results?: Array<{ uri: string; text: string }> } };
      expect(response.structuredContent?.results?.[0]?.text.length).toBeGreaterThan(20);
      expect(response.content.some((block) => block.type === "text" && block.text?.includes("channels.plugins"))).toBe(true);
      expect(response.content.some((block) => block.type === "resource_link")).toBe(true);
      const uri = response.structuredContent?.results?.[0]?.uri;
      expect(uri).toMatch(/^mono-agent-docs:\/\/chunk\/[a-f0-9]{64}$/u);
      const resource = await client.readResource({ uri: uri! });
      expect(resource.contents[0]).toMatchObject({ uri, mimeType: "text/markdown" });
      expect("text" in resource.contents[0]! ? resource.contents[0].text : "").toContain("Source:");
    } finally {
      await client.close();
      await server.close();
    }
  }, 30_000);

  it("serves the packed command boundary over clean stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(packageRoot, "dist", "cli.js")],
      cwd: packageRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "docs-mcp-stdio-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: MONO_AGENT_DOCS_TOOL_NAME,
        arguments: { query: "What command validates an agent configuration?", limit: 2 },
      }) as { structuredContent?: { results?: unknown[] } };
      expect(result.structuredContent?.results).toHaveLength(2);
    } finally {
      await client.close();
    }
  }, 30_000);
});

async function artifactDigests(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of ["chunks.json", "embeddings.f32", "manifest.json"]) {
    result[name] = createHash("sha256").update(await readFile(join(corpusDir, name))).digest("hex");
  }
  return result;
}
