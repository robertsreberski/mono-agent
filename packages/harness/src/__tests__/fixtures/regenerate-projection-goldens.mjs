// Manual only: requires the documented P2b base object. Normal tests never use Git.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, copyFile, symlink, writeFile, rm } from "node:fs/promises";
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const base = "10f501d4f1dc102db9951fcebb09a96001910452";
const scratch = await mkdtemp(join(root, "node_modules", ".p3a-golden-base-"));
try {
  const archive = execFileSync("git", ["archive", base, "packages/harness/src", "packages/agent-runtime/src"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", scratch], { cwd: root, input: archive });
  await writeFile(join(scratch, "package.json"), '{"type":"module"}');
  for (const name of ["harness", "agent-runtime"]) {
    const directory = join(scratch, "packages", name);
    await symlink(relative(directory, join(root, "packages", name, "node_modules")), join(directory, "node_modules"), "dir");
  }
  for (const version of [3, 4]) {
    const storage = join(scratch, `storage-${version}`);
    await mkdir(`${storage}-import/legacy`, { recursive: true, mode: 0o700 });
    const legacy = fileURLToPath(new URL(`./legacy-v${version}.jsonl`, import.meta.url));
    await copyFile(legacy, `${storage}-import/legacy/fixture_fixture-session.jsonl`);
    const output = execFileSync(process.execPath, ["--no-warnings", fileURLToPath(new URL("./projection-parity-worker.mjs", import.meta.url)),
      join(scratch, "packages/harness/src"), join(scratch, "packages/agent-runtime/src"), storage, legacy], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const capture = JSON.parse(output);
    if (!capture.runtime.recovery.recovered || capture.runtime.midRun.requests.length !== 2) throw new Error(`Baseline scenario not exercised: recovered=${capture.runtime.recovery.recovered}; midrun armed=${capture.runtime.midRun.armed}, requests=${capture.runtime.midRun.requests.length}, warnings=${JSON.stringify(capture.runtime.midRun.warnings)}, diagnostics=${JSON.stringify(capture.runtime.midRun.state.compaction.diagnostics)}`);
    await writeFile(new URL(`./projection-golden-v${version}.json`, import.meta.url), JSON.stringify({ base, capture }, null, 2) + "\n");
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
