import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { failClosedSandboxPolicy } from "@mono-agent/sandbox";
import {
  bashToolImpl,
  editToolImpl,
  globToolImpl,
  grepToolImpl,
  readToolImpl,
  normalizeBashTimeoutMs,
  resolveRgPath,
  webFetchToolImpl,
  webSearchToolImpl,
  writeToolImpl,
} from "../../agent/tools/index.js";
import {
  configureToolRuntime,
  resetToolRuntime,
} from "../../agent/tools/shared/runtime-context.js";

const tempDirs = [];
let previousPath = process.env.PATH;

function tempWorkspace() {
  const dir = mkdtempSync(resolve("/tmp", "agent-runtime-tools-"));
  tempDirs.push(dir);
  configureToolRuntime({ workspace: dir });
  return dir;
}

function writeFile(path, content = "") {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  resetToolRuntime();
  resolveRgPath({ refresh: true });
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("ai tool helpers", () => {
  it("normalizes small bash timeout values as seconds", () => {
    expect(normalizeBashTimeoutMs(30)).toBe(30000);
    expect(normalizeBashTimeoutMs(120)).toBe(120000);
    expect(normalizeBashTimeoutMs(120000)).toBe(120000);
    expect(normalizeBashTimeoutMs(999999)).toBe(120000);
  });

  it("glob excludes generated and vendor paths by default", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "app.ts"), "source");
    writeFile(join(root, "node_modules", "pkg", "index.js"), "vendor");
    writeFile(join(root, "dist", "assets", "app.js"), "bundle");
    writeFile(join(root, "src", "app.ts.map"), "sourcemap");

    const result = await globToolImpl({ path: root, pattern: "**/*" });

    expect(result).toContain("src/app.ts");
    expect(result).not.toContain("/node_modules/");
    expect(result).not.toContain("dist/assets");
    expect(result).not.toContain("app.ts.map");
    expect(result).toContain("Excluded directories:");
  });

  it("glob caps broad result previews", async () => {
    const root = tempWorkspace();
    for (let index = 0; index < 5; index += 1) {
      writeFile(join(root, "src", `file-${index}.ts`), "source");
    }

    const result = await globToolImpl({ path: root, pattern: "**/*", max_matches: 2 });

    expect((result.match(/src\/file-/g) || [])).toHaveLength(2);
    expect(result).toContain("[truncated Glob result: showing 2 of 5 lines");
  });

  it("grep excludes generated and vendor paths and caps output", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "one.ts"), "needle one");
    writeFile(join(root, "src", "two.ts"), "needle two");
    writeFile(join(root, "node_modules", "pkg", "index.js"), "needle vendor");
    writeFile(join(root, "dist", "bundle.js"), "needle bundle");
    writeFile(join(root, "src", "bundle.js.map"), "needle map");

    const result = await grepToolImpl({ path: root, pattern: "needle", max_matches: 1 });

    expect(result).toMatch(/src\/(one|two)\.ts/);
    expect(result).not.toContain("/node_modules/");
    expect(result).not.toContain("dist/bundle");
    expect(result).not.toContain("bundle.js.map");
    expect(result).toContain("[truncated Grep result: showing 1 of 2 lines");
  });

  it("resolves relative file paths and shell commands from the configured workspace", async () => {
    const root = tempWorkspace();

    const writeResult = await writeToolImpl({ file_path: "src/relative.txt", content: "hello" });
    const readResult = await readToolImpl({ file_path: "src/relative.txt" });
    const bashResult = await bashToolImpl({ command: "pwd && test -f src/relative.txt && echo ok" });

    expect(writeResult).toContain(join(root, "src", "relative.txt"));
    expect(readResult).toContain("1\thello");
    expect(bashResult).toContain(root);
    expect(bashResult).toContain("ok");
  });

  it("prefers an explicit tool workdir over the default workspace", async () => {
    const root = tempWorkspace();
    const project = mkdtempSync(resolve("/tmp", "agent-runtime-project-tools-"));
    tempDirs.push(project);
    writeFile(join(project, "src", "project.txt"), "from project");

    const writeResult = await writeToolImpl({ file_path: "src/new.txt", content: "new", workdir: project });
    const readResult = await readToolImpl({ file_path: "src/project.txt", workdir: project });
    const globResult = await globToolImpl({ path: ".", pattern: "src/*.txt", workdir: project });
    const bashResult = await bashToolImpl({ command: "pwd && test -f src/project.txt && echo ok", workdir: project });

    expect(writeResult).toContain(join(project, "src", "new.txt"));
    expect(readResult).toContain("1\tfrom project");
    expect(globResult).toContain("src/project.txt");
    expect(globResult).not.toContain(root);
    expect(bashResult).toContain(project);
    expect(bashResult).toContain("ok");
  });

  it("bounds Read output by default and warns on repeated ranges", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "large.txt"), Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n"));

    const first = await readToolImpl({ file_path: "src/large.txt" });
    const second = await readToolImpl({ file_path: "src/large.txt" });

    expect(first).toContain("240\tline 240");
    expect(first).not.toContain("241\tline 241");
    expect(first).toContain("Next unread line: 241");
    expect(second).toContain("already read");
  });

  it("supports bounded grep output modes", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "one.ts"), "needle one");
    writeFile(join(root, "src", "two.ts"), "needle two");

    const filesOnly = await grepToolImpl({ path: root, pattern: "needle", max_matches: 1 });
    const content = await grepToolImpl({ path: root, pattern: "needle", output_mode: "content", head_limit: 2 });

    expect(filesOnly).toMatch(/src\/(one|two)\.ts/);
    expect(filesOnly).not.toContain("needle one");
    expect(content).toContain("src/one.ts:1:needle one");
    expect(content).toContain("src/two.ts:1:needle two");
  });

  it("keeps bash head and tail when truncating large output", async () => {
    const root = tempWorkspace();
    const dataDir = mkdtempSync(resolve("/tmp", "agent-runtime-tool-artifacts-"));
    tempDirs.push(dataDir);
    configureToolRuntime({ toolArtifactDir: dataDir, runId: "run-tools" });

    const result = await bashToolImpl({
      command: "printf 'HEAD'; printf '%04000d' 0; printf 'TAIL'",
      max_output_chars: 500,
      workdir: root,
    });

    expect(result).toContain("HEAD");
    expect(result).toContain("TAIL");
    expect(result).toContain("Full output saved to:");
  });

  it("routes bash execution through the configured sandbox engine", async () => {
    const root = tempWorkspace();
    const result = await bashToolImpl(
      { command: "echo unsandboxed", workdir: root },
      {
        sandboxPolicy: failClosedSandboxPolicy({ root }),
        sandboxEngine: {
          id: "fake",
          async isAvailable() {
            return true;
          },
          async prepareCommand(command) {
            return {
              ...command,
              command: process.execPath,
              args: ["-e", "console.log('sandboxed bash')"],
              sandboxed: true,
            };
          },
        },
      },
    );

    expect(result).toContain("sandboxed bash");
  });

  it("kills the bash process group on timeout", async () => {
    const root = tempWorkspace();
    const marker = `agent-runtime-bash-timeout-${process.pid}-${Date.now()}`;

    const result = await bashToolImpl({
      command: `${process.execPath} -e "setTimeout(() => {}, 5000)" ${marker}`,
      timeout: 1,
      workdir: root,
    });

    expect(result).toContain("Command timed out after 1000ms");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const processes = execFileSync("ps", ["axww", "-o", "command="], { encoding: "utf8" });
    expect(processes).not.toContain(marker);
  });

  it("denies network tools when sandbox policy blocks network", async () => {
    const root = tempWorkspace();
    const sandboxPolicy = failClosedSandboxPolicy({ root });

    const fetchResult = await webFetchToolImpl({ url: "https://example.com" }, { sandboxPolicy });
    const searchResult = await webSearchToolImpl({ query: "mono agent" }, { sandboxPolicy });

    expect(fetchResult).toContain("Network access denied by sandbox policy");
    expect(searchResult).toContain("Network access denied by sandbox policy");
  });

  it("rejects non-http WebFetch URLs before calling fetch", async () => {
    const result = await webFetchToolImpl({ url: "file:///etc/passwd" });

    expect(result).toBe("Error: WebFetch only supports http(s) URLs.");
  });

  it("returns a clean error when ripgrep is unavailable", async () => {
    const root = tempWorkspace();
    configureToolRuntime({ workspace: root, ripgrepPath: join(root, "missing-rg") });
    process.env.PATH = "";
    resolveRgPath({ refresh: true });

    const globResult = await globToolImpl({ path: root, pattern: "**/*" });
    const grepResult = await grepToolImpl({ path: root, pattern: "needle" });

    expect(globResult).toContain("ripgrep (rg) is not available");
    expect(globResult).not.toContain("ENOENT");
    expect(grepResult).toContain("ripgrep (rg) is not available");
    expect(grepResult).not.toContain("ENOENT");
  });

  it("rejects absolute paths outside the workspace boundary", async () => {
    tempWorkspace();
    const outside = "/etc/agent-runtime-not-real";
    const outsideFile = `${outside}/secret.txt`;

    const readResult = await readToolImpl({ file_path: outsideFile });
    const writeResult = await writeToolImpl({ file_path: `${outside}/new.txt`, content: "x" });
    const editResult = await editToolImpl({ file_path: outsideFile, old_string: "do", new_string: "x" });
    const globResult = await globToolImpl({ path: outside, pattern: "**/*" });
    const grepResult = await grepToolImpl({ path: outside, pattern: "do" });

    expect(readResult).toContain("Path not allowed");
    expect(writeResult).toContain("Path not allowed");
    expect(editResult).toContain("Path not allowed");
    expect(globResult).toContain("Path not allowed");
    expect(grepResult).toContain("Path not allowed");
  });

  it("uses sandbox policy roots instead of permissive default roots", async () => {
    const root = tempWorkspace();
    const outsideTmpFile = join(resolve("/tmp"), `mono-agent-outside-${process.pid}.txt`);
    writeFile(outsideTmpFile, "outside");

    configureToolRuntime({
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({ root }),
    });

    const readResult = await readToolImpl({ file_path: outsideTmpFile });
    const bashResult = await bashToolImpl({ command: "pwd", workdir: "/tmp" });

    expect(readResult).toContain("Path not allowed");
    expect(bashResult).toContain("Working directory not allowed");
  });

  it("treats explicit empty sandbox roots as deny-all", async () => {
    const root = tempWorkspace();
    const rootFile = join(root, "secret.txt");
    writeFile(rootFile, "secret");
    const sandboxPolicy = failClosedSandboxPolicy({
      root,
      readableRoots: [],
      writableRoots: [],
    });

    const readResult = await readToolImpl({ file_path: rootFile }, { sandboxPolicy });
    const writeResult = await writeToolImpl({ file_path: join(root, "new.txt"), content: "x" }, { sandboxPolicy });
    const bashResult = await bashToolImpl({ command: "pwd", workdir: root }, { sandboxPolicy });

    expect(readResult).toContain("Path not allowed");
    expect(writeResult).toContain("Path not allowed");
    expect(bashResult).toContain("Working directory not allowed");
  });

  it("applies per-call sandbox policy to file and shell tools", async () => {
    const root = tempWorkspace();
    const outsideTmpFile = join(resolve("/tmp"), `mono-agent-outside-call-${process.pid}.txt`);
    writeFile(outsideTmpFile, "outside");
    const sandboxPolicy = failClosedSandboxPolicy({ root });

    const readResult = await readToolImpl({ file_path: outsideTmpFile }, { sandboxPolicy });
    const writeResult = await writeToolImpl({ file_path: outsideTmpFile, content: "x" }, { sandboxPolicy });
    const globResult = await globToolImpl({ path: "/tmp", pattern: "**/*" }, { sandboxPolicy });
    const grepResult = await grepToolImpl({ path: "/tmp", pattern: "outside" }, { sandboxPolicy });
    const bashResult = await bashToolImpl({ command: "pwd", workdir: "/tmp" }, { sandboxPolicy });

    expect(readResult).toContain("Path not allowed");
    expect(writeResult).toContain("Path not allowed");
    expect(globResult).toContain("Path not allowed");
    expect(grepResult).toContain("Path not allowed");
    expect(bashResult).toContain("Working directory not allowed");
  });

  it("rejects symlink escapes when sandbox policy is configured", async () => {
    const root = tempWorkspace();
    const outside = mkdtempSync(resolve("/tmp", "mono-agent-outside-"));
    tempDirs.push(outside);
    writeFile(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "linked-outside"));

    configureToolRuntime({
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({ root }),
    });

    const readResult = await readToolImpl({ file_path: "linked-outside/secret.txt" });

    expect(readResult).toContain("Path not allowed");
  });

  it("honors sandbox writable roots separately from readable roots", async () => {
    const root = tempWorkspace();
    const readable = mkdtempSync(resolve("/tmp", "mono-agent-readable-"));
    tempDirs.push(readable);
    writeFile(join(readable, "note.txt"), "read only");

    configureToolRuntime({
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({
        root,
        readableRoots: [root, readable],
        writableRoots: [root],
      }),
    });

    const readResult = await readToolImpl({ file_path: join(readable, "note.txt") });
    const writeResult = await writeToolImpl({ file_path: join(readable, "new.txt"), content: "x" });
    const editResult = await editToolImpl({ file_path: join(readable, "note.txt"), old_string: "read", new_string: "write" });

    expect(readResult).toContain("1\tread only");
    expect(writeResult).toContain("Path not allowed");
    expect(editResult).toContain("Path not allowed");
  });

  it("rejects bash workdir outside the workspace boundary", async () => {
    tempWorkspace();

    const result = await bashToolImpl({ command: "pwd", workdir: "/etc/agent-runtime-not-real" });

    expect(result).toContain("Working directory not allowed");
  });
});
