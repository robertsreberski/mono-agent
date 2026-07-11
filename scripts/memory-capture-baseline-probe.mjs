import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_HEAD = "54f3fb492902d56581e72d6fafca54310d59c325";
const repo = process.env.REPO;
const fixturePath = process.env.FIXTURE;
if (!repo || !fixturePath) throw new Error("REPO and FIXTURE are required");

const observedHead = git(repo, ["rev-parse", "HEAD"]);
if (observedHead !== EXPECTED_HEAD) {
  throw new Error(`baseline probe requires ${EXPECTED_HEAD}; observed ${observedHead}`);
}
const trackedStatus = git(repo, ["status", "--porcelain", "--untracked-files=no"]);
if (trackedStatus.length > 0) throw new Error(`baseline worktree has tracked changes:\n${trackedStatus}`);

const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
const fixtureSha256 = sha256(fixtureBytes);
const probeSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
const distFiles = [
  "packages/memory/dist/bujo/capture.js",
  "packages/memory/dist/bujo/reconcile.js",
  "packages/memory/dist/bujo/distill.js",
  "packages/memory/dist/bujo/entities.js",
  "packages/memory/dist/store/db.js",
];
const distSha256 = Object.fromEntries(await Promise.all(distFiles.map(async (path) => {
  const bytes = await readFile(join(repo, path));
  return [path, sha256(bytes)];
})));
const batchedCaptureSourceAbsent = !existsSync(join(repo, "packages/memory/src/bujo/capture-batch.ts"));
if (!batchedCaptureSourceAbsent) throw new Error("baseline unexpectedly contains batched capture source");
const captureDist = await readFile(join(repo, "packages/memory/dist/bujo/capture.js"), "utf8");
const legacyCaptureDistVerified = captureDist.includes('from "./distill.js"')
  && captureDist.includes('from "./entities.js"')
  && !captureDist.includes("capture-batch")
  && !captureDist.includes("capture:extract");
if (!legacyCaptureDistVerified) throw new Error("baseline capture dist is not the legacy 5-call implementation");

const storeModule = await import(pathToFileURL(join(repo, "packages/memory/dist/store/index.js")));
const bujoModule = await import(pathToFileURL(join(repo, "packages/memory/dist/bujo/index.js")));
const root = await mkdtemp(join(tmpdir(), "goal195-old-capture-"));
const now = new Date("2026-07-11T00:00:00.000Z");
const embeddings = {
  id: "fixture:2",
  async embed(texts) {
    return texts.map((text) => /hiking trip/iu.test(text) ? [0, 1] : [1, 0]);
  },
};
const db = storeModule.openMemoryDb({ path: join(root, "memory.db"), embeddings, dim: 2, clock: () => now });
try {
  for (const seed of fixture.seeds) {
    const bullet = {
      id: seed.id,
      type: "note",
      status: "open",
      text: seed.text,
      salience: 0.5,
      isInsight: false,
      createdAt: now.toISOString(),
      refs: [],
    };
    bujoModule.appendBullet(root, bullet, now);
    await db.upsert({
      ...bullet,
      accessCount: 0,
      tags: [],
      source: { file: relative(root, bujoModule.dailyFilePath(root, now)) },
    });
  }
  const labels = [];
  const llm = {
    id: "fixture-llm",
    async complete(prompt, options = {}) {
      labels.push(options.label ?? "unlabeled");
      if (options.label === "capture:distill") {
        return JSON.stringify(fixture.candidates.map(({ decision: _decision, entityIds: _entityIds, ...candidate }) => candidate));
      }
      if (options.label === "capture:reconcile") {
        const candidateText = /CANDIDATE: type=[^ ]+ text="([^"]+)"/u.exec(prompt)?.[1];
        const candidate = fixture.candidates.find((item) => item.text === candidateText);
        if (!candidate) throw new Error("unmatched reconcile prompt");
        return JSON.stringify(candidate.decision);
      }
      if (options.label === "capture:entities") {
        return JSON.stringify({ entities: fixture.entities, relations: fixture.relations });
      }
      throw new Error(`unexpected label ${String(options.label)}`);
    },
  };
  let sequence = 0;
  const result = await bujoModule.captureTurn(fixture.turnText, {
    db,
    root,
    llm,
    nextId: () => `new-${++sequence}`,
    now: () => now,
  });
  process.stdout.write(`${JSON.stringify({
    schema: 2,
    expectedHead: EXPECTED_HEAD,
    observedHead,
    trackedClean: true,
    batchedCaptureSourceAbsent,
    legacyCaptureDistVerified,
    fixtureSha256,
    probeSha256,
    distSha256,
    candidates: fixture.candidates.length,
    reconcileRequired: fixture.candidates.filter((candidate) => candidate.decision.action !== "add").length,
    calls: labels.length,
    labels,
    actions: result.actions,
    entities: result.entities,
    relations: result.relations,
  }, null, 2)}\n`);
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
