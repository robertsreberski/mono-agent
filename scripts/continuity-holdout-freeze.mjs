#!/usr/bin/env node
import { mkdir, readdir, lstat } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { loadHoldoutSpec, generateHoldout, selectHoldoutCases, HOLDOUT_VERSION } from "./lib/continuity-holdout-generator.mjs";
import { checkHoldoutOverlap } from "./lib/continuity-holdout-overlap.mjs";
import { digest } from "./lib/continuity-dataset.mjs";
import { CHECKOUT, assertCleanTree, benchmarkFiles, externalDirectory, externalFile, runtimeProvenance, jsonBytes, parseFlags, readJson, regularFile, runCli, sha256, toolingRevision, writeExclusive } from "./lib/continuity-holdout-files.mjs";

export async function freezeHoldout({ specDir, seedsPath, rubricPath, protocolPath, overlapPath, allowlistPath, outputDir }) {
  assertCleanTree();
  const tooling = benchmarkFiles(), runtime = await runtimeProvenance();
  const spec = await loadHoldoutSpec(specDir), seeds = await readJson(seedsPath), allowlist = await readJson(allowlistPath);
  const supplied = await readJson(overlapPath), report = await checkHoldoutOverlap(spec, seeds, allowlist);
  if (!report.pass || digest(report) !== digest(supplied)) throw new Error("overlap_report_not_passing_or_stale");
  const rubric = await externalFile(rubricPath), protocol = await externalFile(protocolPath);
  if (!rubric.length || !protocol.length) throw new Error("empty_registration_input");
  const out = await externalDirectory(outputDir);
  await externalDirectory(dirname(out), true);
  await mkdir(out, { mode: 0o700 }); // Never overwrite a prior freeze, even an empty directory.
  const files = {};
  const put = async (name, bytes) => {
    await mkdir(dirname(resolve(out, name)), { recursive: true, mode: 0o700 });
    await writeExclusive(resolve(out, name), bytes);
    files[name] = { sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) };
  };
  await put("spec.json", jsonBytes(spec));
  await put("seeds.json", jsonBytes(seeds));
  await put("allowlist.json", jsonBytes(allowlist));
  await put("overlap.json", jsonBytes(report));
  await put("rubric", rubric); await put("protocol", protocol);
  const selection = selectHoldoutCases(spec, seeds).map(({ family, item, seed }) => ({ id: item.id, family: family.id, group: family.group, seed }));
  await put("selection.json", jsonBytes(selection));
  const conversations = [];
  for (const trace of generateHoldout(spec, seeds)) {
    const path = `conversations/${trace.id}.json`, answers = `answers/${trace.id}.json`;
    await put(path, jsonBytes(trace));
    await put(answers, jsonBytes(trace.probes.map(p => ({ id: p.id, category: p.category, score: p.score, evidence: p.evidence }))));
    conversations.push({ id: trace.id, group: trace.generated.group, family: trace.generated.scenario, seed: trace.generated.seed, path, answers });
  }
  for (const name of tooling) await put(`tooling/${name}`, await regularFile(resolve(CHECKOUT, name)));
  const manifest = { schema: "holdout-freeze-v1", generator: HOLDOUT_VERSION, toolingRevision: toolingRevision(), runtime,
    specSha256: digest(spec), seedsSha256: digest(seeds), overlapSha256: digest(report), allowlistSha256: digest(allowlist),
    mixture: spec.families.map(f => ({ id: f.id, group: f.group, count: f.count })), conversations, files };
  assertCleanTree();
  const bytes = jsonBytes(manifest);
  await writeExclusive(resolve(out, "manifest.json"), bytes);
  const manifestSha256 = sha256(bytes);
  await writeExclusive(resolve(out, "manifest.sha256"), manifestSha256 + "\n");
  return { manifestSha256, conversations: conversations.length };
}

/** The digest must come from the custodian's independent registration, not this directory. */
export async function verifyHoldout(directory, expectedManifestSha256) {
  assertCleanTree();
  const dir = await externalDirectory(directory), bytes = await regularFile(resolve(dir, "manifest.json"));
  if (!/^[a-f0-9]{64}$/u.test(expectedManifestSha256 ?? "") || sha256(bytes) !== expectedManifestSha256) throw new Error("manifest_hash_mismatch");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schema !== "holdout-freeze-v1" || jsonBytes(manifest) !== bytes.toString("utf8")) throw new Error("manifest_schema_mismatch");
  const expected = new Set(["manifest.json", "manifest.sha256", ...Object.keys(manifest.files)]);
  const walk = async directory => {
    for (const name of await readdir(directory)) {
      const path = resolve(directory, name), stat = await lstat(path);
      if (stat.isDirectory()) await walk(path);
      else if (!stat.isFile() || !expected.has(relative(dir, path))) throw new Error("unexpected_frozen_file");
    }
  };
  await walk(dir);
  if ((await regularFile(resolve(dir, "manifest.sha256"))).toString("utf8") !== expectedManifestSha256 + "\n") throw new Error("manifest_hash_mismatch");
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (name.startsWith("/") || name.split("/").some(p => !p || p === "." || p === "..")) throw new Error("invalid_manifest_path");
    const file = await regularFile(resolve(dir, name));
    if (file.length !== entry.bytes || sha256(file) !== entry.sha256) throw new Error(`frozen_file_mutated:${name}`);
  }
  const runtime = await runtimeProvenance();
  if (runtime.node.split(".")[0] !== manifest.runtime?.node.split(".")[0] || runtime.lockfileSha256 !== manifest.runtime?.lockfileSha256
    || runtime.typescript !== manifest.runtime?.typescript) throw new Error("runtime_provenance_mismatch");
  const tooling = Object.keys(manifest.files).filter(name => name.startsWith("tooling/")).map(name => name.slice(8));
  if (jsonBytes(tooling.sort()) !== jsonBytes(benchmarkFiles())) throw new Error("benchmark_file_inventory_changed");
  for (const name of tooling) if (sha256(await regularFile(resolve(CHECKOUT, name))) !== manifest.files[`tooling/${name}`]?.sha256) throw new Error("current_tooling_mutated");
  assertCleanTree();
  return { pass: true, manifestSha256: expectedManifestSha256, conversations: manifest.conversations.length };
}

export async function main(argv) {
  const command = argv[0];
  if (command === "verify") {
    const f = parseFlags(argv.slice(1), ["--directory", "--manifest-sha256"]);
    console.log(jsonBytes(await verifyHoldout(f["--directory"], f["--manifest-sha256"])).trim());
  } else if (command === "freeze") {
    const f = parseFlags(argv.slice(1), ["--spec-dir", "--seeds", "--rubric", "--protocol", "--overlap", "--allowlist", "--output"]);
    console.log(jsonBytes(await freezeHoldout({ specDir: f["--spec-dir"], seedsPath: f["--seeds"], rubricPath: f["--rubric"], protocolPath: f["--protocol"], overlapPath: f["--overlap"], allowlistPath: f["--allowlist"], outputDir: f["--output"] })).trim());
  } else throw new Error("expected_freeze_or_verify");
}
await runCli(import.meta.url, main);
