import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
  embedding: vi.fn(() => { throw new Error("unexpected embedding construction"); }),
  recall: vi.fn(() => { throw new Error("unexpected recall construction"); }),
  writer: vi.fn(() => { throw new Error("unexpected writer acquisition"); }),
}));

vi.mock("../memory/memory-recall.js", () => ({
  createMemoryEmbeddingProvider: effects.embedding,
  createRecallStore: effects.recall,
}));
vi.mock("@mono-agent/memory/bujo", async (original) => ({
  ...await original<typeof import("@mono-agent/memory/bujo")>(),
  createBujoMemoryStore: effects.writer,
  applyExplicitMemoryForget: effects.writer,
  applyMemoryBundleImport: effects.writer,
  safeRebuildMemoryIndex: effects.writer,
  rollbackMemoryIndex: effects.writer,
}));

import { runMemoryCommand } from "../memory-command.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("pins complete human/JSON read transcripts without initializing an empty stopped store", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-command-output-"));
  roots.push(root);
  // macOS temp roots canonicalize through /private; normalize both spellings so the transcript is platform-neutral.
  const realRoot = await realpath(root);
  const normalize = (text: string) => text.replaceAll(realRoot, "<root>").replaceAll(root, "<root>");
  await mkdir(join(root, "home"));
  // The existing active-path resolver creates a missing root. Start with an
  // empty private root to pin read-only observation without changing that API.
  await mkdir(join(root, "memory"), { mode: 0o700 });
  await writeFile(join(root, "IDENTITY.md"), "# Fictional test agent\n");
  await writeFile(join(root, "mono-agent.config.json"), JSON.stringify({
    runtime: { model: "ollama:test-model" },
    context: { identityPath: "./IDENTITY.md" },
    memory: {
      mode: "bujo", path: "./memory", writeMode: "append-host-summary",
      embeddings: { provider: "ollama", model: "test-embed", dim: 3 },
      llm: { provider: "ollama", model: "fictional-model" },
    },
  }));
  vi.setSystemTime(new Date("2026-04-03T10:00:00.000Z"));
  const before = await snapshot(root);
  const cases: readonly Partial<Parameters<typeof runMemoryCommand>[0]>[] = [
    { positionals: ["stats"] },
    { positionals: ["show", "2026-04-03"] },
    { positionals: ["search", "fictional", "query"] },
    { positionals: ["top"] },
    { positionals: ["profile", "show"] },
    { positionals: ["labels"] },
    { positionals: ["entities"], duplicates: true },
    { positionals: ["lessons"], propose: true },
    { positionals: ["audit"] },
    { positionals: ["audit"], strict: true },
    { positionals: ["inspect"] },
  ];
  const transcript = [];
  for (const json of [false, true]) {
    for (const options of cases) {
      const output = await capture(() => runMemoryCommand({
        cwd: root, env: { HOME: join(root, "home") }, positionals: [], json, strict: false, ...options,
      }));
      expect(output.stderr).toBe("");
      if (options.strict !== true) expect(output.code).toBe(0);
      transcript.push({ ...options, json, ...output,
        stdout: normalize(output.stdout), stderr: normalize(output.stderr) });
      expect(await snapshot(root), JSON.stringify(options)).toEqual(before);
    }
  }
  expect(transcript).toMatchSnapshot();
  expect(effects.embedding).not.toHaveBeenCalled();
  expect(effects.recall).not.toHaveBeenCalled();
  expect(effects.writer).not.toHaveBeenCalled();
});

it.each([false, true])("pins bounded export/import refusals on a stopped non-BuJo store (json=%s)", async (json) => {
  const root = await mkdtemp(join(tmpdir(), "memory-bundle-output-"));
  roots.push(root);
  await writeFile(join(root, "IDENTITY.md"), "# Fictional test agent\n");
  await writeFile(join(root, "mono-agent.config.json"), JSON.stringify({
    runtime: { model: "ollama:test-model" }, context: { identityPath: "./IDENTITY.md" },
    memory: { mode: "lite", path: "./memory", writeMode: "append-host-summary" },
  }));
  const before = await snapshot(root);
  const transcript = [];
  for (const positionals of [["export"], ["import", "prepare"], ["import", "apply"], ["import", "restore"]]) {
    transcript.push(await capture(() => runMemoryCommand({
      cwd: root, env: {}, positionals, json, strict: false,
      ...(positionals[0] === "export" ? { bundlePath: "bundle" }
        : positionals[1] === "prepare" ? { bundlePath: "bundle", planPath: "plan" }
          : positionals[1] === "apply" ? { planPath: "plan" } : { backupPath: "backup" }),
    })));
  }
  expect(transcript).toMatchSnapshot();
  expect(await snapshot(root)).toEqual(before);
  expect(effects.embedding).not.toHaveBeenCalled();
  expect(effects.recall).not.toHaveBeenCalled();
  expect(effects.writer).not.toHaveBeenCalled();
});

async function snapshot(root: string): Promise<unknown> {
  const entries = await readdir(root);
  return await Promise.all(entries.sort().map(async (name) => {
    const path = join(root, name);
    const info = await lstat(path);
    return { name, mode: info.mode, dev: info.dev, ino: info.ino, nlink: info.nlink,
      mtime: info.mtimeMs, ctime: info.ctimeMs,
      content: info.isDirectory() ? await snapshot(path) : (await readFile(path)).toString("hex") };
  }));
}

async function capture(run: () => Promise<number>) {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
  try { return { code: await run(), stdout, stderr }; }
  finally { out.mockRestore(); err.mockRestore(); }
}
