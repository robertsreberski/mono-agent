import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DocsCorpusChunk {
  readonly id: string;
  readonly source: "composer" | "docs";
  readonly path: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly canonicalUrl?: string;
  readonly text: string;
  readonly embeddingText: string;
}

export interface DocsCorpusManifest {
  readonly schema: "mono-agent.docs-corpus.v1";
  readonly docsVersion: string;
  readonly sourceDigest: string;
  readonly corpusDigest: string;
  readonly chunkerVersion: string;
  readonly chunkCount: number;
  readonly model: {
    readonly package: "@yarflam/potion-base-8m";
    readonly version: "1.0.4";
    readonly id: "minishlab/potion-base-8M";
    readonly dimensions: 256;
  };
  readonly artifacts: {
    readonly chunksSha256: string;
    readonly embeddingsSha256: string;
    readonly byteOrder: "little-endian";
  };
}

export interface DocsCorpus {
  readonly manifest: DocsCorpusManifest;
  readonly chunks: readonly DocsCorpusChunk[];
  readonly embeddings: readonly Float32Array[];
  readonly chunksById: ReadonlyMap<string, DocsCorpusChunk>;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS_DIR = basename(moduleDirectory) === "src"
  ? join(moduleDirectory, "..", "dist", "corpus")
  : join(moduleDirectory, "corpus");

export async function loadDocsCorpus(corpusDir = DEFAULT_CORPUS_DIR): Promise<DocsCorpus> {
  const [manifestBytes, chunksBytes, embeddingsBytes] = await Promise.all([
    readFile(join(corpusDir, "manifest.json")),
    readFile(join(corpusDir, "chunks.json")),
    readFile(join(corpusDir, "embeddings.f32")),
  ]);
  const manifest = parseManifest(manifestBytes.toString("utf8"));
  assertChecksum("chunks.json", chunksBytes, manifest.artifacts.chunksSha256);
  assertChecksum("embeddings.f32", embeddingsBytes, manifest.artifacts.embeddingsSha256);

  const calculatedCorpusDigest = createHash("sha256")
    .update(chunksBytes)
    .update(embeddingsBytes)
    .digest("hex");
  if (calculatedCorpusDigest !== manifest.corpusDigest) {
    throw new Error(`Documentation corpus digest mismatch: expected ${manifest.corpusDigest}, received ${calculatedCorpusDigest}.`);
  }

  const chunks = parseChunks(chunksBytes.toString("utf8"));
  if (chunks.length !== manifest.chunkCount) {
    throw new Error(`Documentation corpus chunk count mismatch: manifest=${manifest.chunkCount}, chunks=${chunks.length}.`);
  }

  const expectedBytes = chunks.length * manifest.model.dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (embeddingsBytes.byteLength !== expectedBytes) {
    throw new Error(`Documentation embedding byte length mismatch: expected ${expectedBytes}, received ${embeddingsBytes.byteLength}.`);
  }
  const embeddings = chunks.map((_chunk, chunkIndex) => {
    const vector = new Float32Array(manifest.model.dimensions);
    const offset = chunkIndex * manifest.model.dimensions * Float32Array.BYTES_PER_ELEMENT;
    for (let dimension = 0; dimension < manifest.model.dimensions; dimension += 1) {
      const value = embeddingsBytes.readFloatLE(offset + (dimension * Float32Array.BYTES_PER_ELEMENT));
      if (!Number.isFinite(value)) {
        throw new Error(`Documentation embedding ${chunkIndex}:${dimension} is not finite.`);
      }
      vector[dimension] = value;
    }
    return vector;
  });

  const chunksById = new Map<string, DocsCorpusChunk>();
  for (const chunk of chunks) {
    if (chunksById.has(chunk.id)) {
      throw new Error(`Documentation corpus contains duplicate chunk id ${chunk.id}.`);
    }
    chunksById.set(chunk.id, chunk);
  }
  return { manifest, chunks, embeddings, chunksById };
}

function assertChecksum(name: string, bytes: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Documentation corpus ${name} checksum mismatch: expected ${expected}, received ${actual}.`);
  }
}

function parseManifest(raw: string): DocsCorpusManifest {
  const value = JSON.parse(raw) as unknown;
  if (!isObject(value)
    || value.schema !== "mono-agent.docs-corpus.v1"
    || typeof value.docsVersion !== "string"
    || !isSha256(value.sourceDigest)
    || !isSha256(value.corpusDigest)
    || typeof value.chunkerVersion !== "string"
    || !Number.isInteger(value.chunkCount)
    || !isObject(value.model)
    || value.model.package !== "@yarflam/potion-base-8m"
    || value.model.version !== "1.0.4"
    || value.model.id !== "minishlab/potion-base-8M"
    || value.model.dimensions !== 256
    || !isObject(value.artifacts)
    || !isSha256(value.artifacts.chunksSha256)
    || !isSha256(value.artifacts.embeddingsSha256)
    || value.artifacts.byteOrder !== "little-endian") {
    throw new Error("Documentation corpus manifest is invalid or unsupported.");
  }
  return value as unknown as DocsCorpusManifest;
}

function parseChunks(raw: string): readonly DocsCorpusChunk[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) {
    throw new Error("Documentation corpus chunks.json must contain an array.");
  }
  return value.map((candidate, index) => {
    if (!isObject(candidate)
      || !/^[a-f0-9]{64}$/u.test(String(candidate.id))
      || (candidate.source !== "composer" && candidate.source !== "docs")
      || typeof candidate.path !== "string"
      || typeof candidate.title !== "string"
      || !Array.isArray(candidate.headingPath)
      || !candidate.headingPath.every((part) => typeof part === "string")
      || (candidate.canonicalUrl !== undefined && typeof candidate.canonicalUrl !== "string")
      || typeof candidate.text !== "string"
      || typeof candidate.embeddingText !== "string") {
      throw new Error(`Documentation corpus chunk ${index} is invalid.`);
    }
    return candidate as unknown as DocsCorpusChunk;
  });
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
