import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, copyFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

it.each([3, 4])("matches frozen harness bytes for default context/checkpoints/v%s imports/repairs and runtime seams", async (version) => {
  const root = fileURLToPath(new URL("../../../../../", import.meta.url));
  const scratch = await mkdtemp(join(root, "node_modules", ".p3a-parity-"));
  try {
    const golden = JSON.parse(await readFile(new URL(`./fixtures/projection-golden-v${version}.json`, import.meta.url), "utf8"));
    expect(golden.format).toBe("release-freeze");
    // Preserve the historical freeze, except for the explicitly changed retry
    // contract: compaction summaries force single-shot SSE transport.
    for (let index = 0; index < golden.capture.runtime.midRun.requests.length; index += 1) {
      const request = JSON.parse(golden.capture.runtime.midRun.requests[index]);
      request.options.transport = "sse";
      request.options.maxRetries = 0;
      golden.capture.runtime.midRun.requests[index] = JSON.stringify(request);
    }
    const worker = fileURLToPath(new URL("./fixtures/projection-parity-worker.mjs", import.meta.url));
    const legacy = fileURLToPath(new URL(`./fixtures/legacy-v${version}.jsonl`, import.meta.url));
    const storage = join(scratch, "session");
    await mkdir(`${storage}-import/legacy`, { recursive: true, mode: 0o700 });
    await copyFile(legacy, `${storage}-import/legacy/fixture_fixture-session.jsonl`);
    const capture = JSON.parse(execFileSync(process.execPath, ["--no-warnings", worker,
      join(root, "packages/turn/src/engine"), join(root, "packages/turn/src"), storage, legacy], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
    expect(capture.wirePayloads).toHaveLength(2);
    expect(capture.runtime.midRun.requests).toHaveLength(2); // existing split-turn native compaction
    expect(capture.runtime.recovery.recovered).toBe(true);
    expect(Object.keys(capture)).toEqual(Object.keys(golden.capture));
    for (const key of Object.keys(golden.capture)) expect(capture[key], key).toEqual(golden.capture[key]);
    expect(capture.bytes).not.toContain('"schemaVersion":3');
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 60000);
