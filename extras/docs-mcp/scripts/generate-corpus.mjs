import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { embed } from "@yarflam/potion-base-8m";

const MODEL_DIMENSIONS = 256;
const MODEL_VERSION = "1.0.4";
const CHUNKER_VERSION = "markdown-blocks-v1";
const MAX_CHUNK_CHARACTERS = 1_200;
const MAX_OVERLAP_CHARACTERS = 200;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const outputDirectory = join(packageRoot, "dist", "corpus");

const sources = await collectSources();
const sourceHash = createHash("sha256");
const chunks = [];
for (const source of sources) {
  sourceHash.update(source.path).update("\0").update(source.markdown).update("\0");
  chunks.push(...chunkMarkdown(source));
}
assertUniqueChunkIds(chunks);

const embeddings = [];
for (let offset = 0; offset < chunks.length; offset += 128) {
  const batch = chunks.slice(offset, offset + 128);
  const vectors = await embed(batch.map((chunk) => chunk.embeddingText));
  embeddings.push(...vectors);
}
if (embeddings.length !== chunks.length) {
  throw new Error(`Embedding count mismatch: chunks=${chunks.length}, embeddings=${embeddings.length}.`);
}

const embeddingBytes = Buffer.alloc(chunks.length * MODEL_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT);
for (let chunkIndex = 0; chunkIndex < embeddings.length; chunkIndex += 1) {
  const vector = embeddings[chunkIndex];
  if (!(vector instanceof Float32Array) || vector.length !== MODEL_DIMENSIONS) {
    throw new Error(`Embedding ${chunkIndex} must be a ${MODEL_DIMENSIONS}-dimension Float32Array.`);
  }
  for (let dimension = 0; dimension < MODEL_DIMENSIONS; dimension += 1) {
    const value = vector[dimension];
    if (!Number.isFinite(value)) {
      throw new Error(`Embedding ${chunkIndex}:${dimension} is not finite.`);
    }
    const byteOffset = ((chunkIndex * MODEL_DIMENSIONS) + dimension) * Float32Array.BYTES_PER_ELEMENT;
    embeddingBytes.writeFloatLE(value, byteOffset);
  }
}

const chunksBytes = Buffer.from(`${JSON.stringify(chunks)}\n`, "utf8");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const chunksSha256 = sha256(chunksBytes);
const embeddingsSha256 = sha256(embeddingBytes);
const manifest = {
  schema: "mono-agent.docs-corpus.v1",
  docsVersion: packageJson.version,
  sourceDigest: sourceHash.digest("hex"),
  corpusDigest: createHash("sha256").update(chunksBytes).update(embeddingBytes).digest("hex"),
  chunkerVersion: CHUNKER_VERSION,
  chunkCount: chunks.length,
  model: {
    package: "@yarflam/potion-base-8m",
    version: MODEL_VERSION,
    id: "minishlab/potion-base-8M",
    dimensions: MODEL_DIMENSIONS,
  },
  artifacts: {
    chunksSha256,
    embeddingsSha256,
    byteOrder: "little-endian",
  },
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(join(outputDirectory, "chunks.json"), chunksBytes),
  writeFile(join(outputDirectory, "embeddings.f32"), embeddingBytes),
  writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
]);
process.stderr.write(`Generated ${chunks.length} mono-agent documentation chunks (${manifest.corpusDigest.slice(0, 12)}).\n`);

async function collectSources() {
  const docsRoot = join(repositoryRoot, "docs");
  const docsFiles = (await walkMarkdown(docsRoot))
    .filter((path) => {
      const firstSegment = relative(docsRoot, path).split(sep)[0];
      return firstSegment !== "skills" && firstSegment !== "superpowers";
    })
    .map((path) => ({ path, source: "docs" }));
  const composerRoot = join(repositoryRoot, "packages", "agent-app", "skills", "mono-agent-composer");
  const composerFiles = [
    join(composerRoot, "SKILL.md"),
    ...(await walkMarkdown(join(composerRoot, "references"))),
  ].map((path) => ({ path, source: "composer" }));

  const records = [];
  for (const record of [...docsFiles, ...composerFiles].sort((left, right) => left.path.localeCompare(right.path))) {
    const markdown = await readFile(record.path, "utf8");
    const logicalPath = record.source === "docs"
      ? `docs/${toPosixPath(relative(docsRoot, record.path))}`
      : `composer/${toPosixPath(relative(composerRoot, record.path))}`;
    records.push({
      source: record.source,
      path: logicalPath,
      markdown,
      canonicalUrl: record.source === "docs" ? canonicalDocsUrl(logicalPath) : undefined,
    });
  }
  return records;
}

async function walkMarkdown(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await walkMarkdown(path));
    } else if (entry.isFile() && [".md", ".mdx"].includes(extname(entry.name))) {
      paths.push(path);
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

function chunkMarkdown(source) {
  const markdown = stripFrontmatter(source.markdown).replace(/\r\n?/gu, "\n");
  const lines = markdown.split("\n");
  const blocks = [];
  const headingPath = [];
  let title;
  let blockLines = [];
  let fenceMarker;

  const flushBlock = () => {
    const text = blockLines.join("\n").trim();
    blockLines = [];
    if (text.length > 0) blocks.push({ headingPath: [...headingPath], text });
  };

  for (const line of lines) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fenceMarker !== undefined) {
      blockLines.push(line);
      if (fence !== undefined && fence[0] === fenceMarker[0] && fence.length >= fenceMarker.length) {
        fenceMarker = undefined;
        flushBlock();
      }
      continue;
    }
    if (fence !== undefined) {
      flushBlock();
      fenceMarker = fence;
      blockLines.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (heading !== null) {
      flushBlock();
      const level = heading[1].length;
      const text = heading[2].trim();
      if (level === 1 && title === undefined) title = text;
      if (level >= 2) {
        headingPath.length = level - 2;
        headingPath[level - 2] = text;
      }
      continue;
    }
    if (line.trim().length === 0) {
      flushBlock();
    } else {
      blockLines.push(line);
    }
  }
  flushBlock();

  const sourceTitle = title ?? humanizeFilename(source.path);
  const chunks = [];
  let current;
  for (const block of blocks) {
    const segments = splitOversizedBlock(block.text);
    for (const segment of segments) {
      const headingKey = block.headingPath.join("\0");
      if (current === undefined || current.headingKey !== headingKey || joinedLength(current.parts, segment) > MAX_CHUNK_CHARACTERS) {
        if (current !== undefined) chunks.push(finalizeChunk(source, sourceTitle, current.headingPath, current.parts.join("\n\n")));
        const overlap = current === undefined || current.headingKey !== headingKey
          ? ""
          : overlapTail(current.parts.join("\n\n"), segment.length);
        current = {
          headingKey,
          headingPath: block.headingPath,
          parts: overlap.length === 0 ? [segment] : [overlap, segment],
        };
      } else {
        current.parts.push(segment);
      }
    }
  }
  if (current !== undefined) chunks.push(finalizeChunk(source, sourceTitle, current.headingPath, current.parts.join("\n\n")));
  return chunks;
}

function splitOversizedBlock(block) {
  if (block.length <= MAX_CHUNK_CHARACTERS) return [block];
  const lines = block.split("\n");
  const openingFence = /^\s{0,3}(`{3,}|~{3,})/u.exec(lines[0] ?? "")?.[1];
  const closingFence = openingFence === undefined
    ? undefined
    : [...lines].reverse().find((line, reverseIndex) => reverseIndex < lines.length - 1
      && new RegExp(`^\\s{0,3}${escapeRegExp(openingFence[0])}{${openingFence.length},}\\s*$`, "u").test(line));
  if (openingFence !== undefined && closingFence !== undefined) {
    const body = lines.slice(1, -1);
    const segments = [];
    let current = [];
    for (const line of body) {
      const candidate = [lines[0], ...current, line, closingFence].join("\n");
      if (candidate.length > MAX_CHUNK_CHARACTERS && current.length > 0) {
        segments.push([lines[0], ...current, closingFence].join("\n"));
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) segments.push([lines[0], ...current, closingFence].join("\n"));
    return segments.flatMap((segment) => segment.length <= MAX_CHUNK_CHARACTERS ? [segment] : splitPlainText(segment));
  }
  return splitPlainText(block);
}

function splitPlainText(text) {
  const segments = [];
  let remaining = text;
  while (remaining.length > MAX_CHUNK_CHARACTERS) {
    const window = remaining.slice(0, MAX_CHUNK_CHARACTERS + 1);
    const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const splitAt = boundary >= Math.floor(MAX_CHUNK_CHARACTERS * 0.6) ? boundary : MAX_CHUNK_CHARACTERS;
    segments.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) segments.push(remaining);
  return segments;
}

function finalizeChunk(source, title, headingPath, text) {
  const id = createHash("sha256")
    .update(source.source).update("\0")
    .update(source.path).update("\0")
    .update(headingPath.join("\0")).update("\0")
    .update(text)
    .digest("hex");
  return {
    id,
    source: source.source,
    path: source.path,
    title,
    headingPath,
    ...(source.canonicalUrl === undefined ? {} : { canonicalUrl: source.canonicalUrl }),
    text,
    embeddingText: [title, headingPath.join(" > "), text].filter(Boolean).join("\n"),
  };
}

function joinedLength(parts, next) {
  return parts.reduce((sum, part) => sum + part.length, 0) + (parts.length * 2) + next.length;
}

function overlapTail(previous, nextLength) {
  const available = MAX_CHUNK_CHARACTERS - nextLength - 2;
  if (available < 40) return "";
  const tailLength = Math.min(MAX_OVERLAP_CHARACTERS, available, previous.length);
  const rawTail = previous.slice(-tailLength);
  const firstWhitespace = rawTail.search(/\s/u);
  return (firstWhitespace === -1 ? rawTail : rawTail.slice(firstWhitespace + 1)).trim();
}

function stripFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---\n", 4);
  return end === -1 ? markdown : markdown.slice(end + 5);
}

function canonicalDocsUrl(logicalPath) {
  let route = logicalPath.replace(/^docs\//u, "").replace(/\.(?:md|mdx)$/u, "");
  route = route.replace(/(?:^|\/)index$/u, "");
  return `https://mono-agent-docs.vercel.app/${route.length === 0 ? "" : `${route}/`}`;
}

function humanizeFilename(path) {
  return basename(path, extname(path)).replace(/[-_]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function assertUniqueChunkIds(chunks) {
  const ids = new Set();
  for (const chunk of chunks) {
    if (ids.has(chunk.id)) throw new Error(`Duplicate documentation chunk id ${chunk.id}.`);
    ids.add(chunk.id);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
