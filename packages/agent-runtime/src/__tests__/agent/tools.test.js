import { createToolContext, updateToolContext } from "../../agent/tools/shared/tool-context.js";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encode as encodeBmp } from "bmp-ts";
import sharp from "sharp";
import { createFakeSandbox, testSandboxPolicy as failClosedSandboxPolicy } from "../helpers/fake-sandbox.js";
import {
  bashToolImpl,
  execToolImpl,
  editToolImpl,
  globToolImpl,
  grepToolImpl,
  readToolImpl,
  normalizeBackgroundBashTimeoutMs,
  normalizeBackgroundTimeoutMs,
  normalizeBashTimeoutMs,
  resolveRgPath,
  webFetchToolImpl,
  webSearchToolImpl,
  writeToolImpl,
} from "../../agent/tools/index.js";

const tempDirs = [];
let ctx = createToolContext();
let previousPath = process.env.PATH;

function tempWorkspace() {
  const dir = mkdtempSync(resolve("/tmp", "agent-runtime-tools-"));
  tempDirs.push(dir);
  // The fake sandbox fixture gives these tests realistic root/write/network
  // enforcement without a workspace dependency — see helpers/fake-sandbox.js.
  updateToolContext(ctx, { workspace: dir, sandbox: createFakeSandbox() });
  return dir;
}

function writeFile(path, content = "") {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  ctx = createToolContext();
  resolveRgPath({ ctx, refresh: true });
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("ai tool helpers", () => {
  it("normalizes small bash timeout values as seconds", () => {
    expect(normalizeBashTimeoutMs(30)).toBe(30000);
    expect(normalizeBashTimeoutMs(120)).toBe(120000);
    expect(normalizeBashTimeoutMs(120000)).toBe(120000);
    expect(normalizeBashTimeoutMs(999999)).toBe(120000);
  });

  it("keeps a background timeout unbounded by the foreground default", () => {
    // The foreground ceiling used to double as a cap here, so a four-hour
    // background job was silently launched with a two-minute runtime limit.
    expect(normalizeBackgroundTimeoutMs(14_400_000)).toBe(14_400_000);
    expect(normalizeBackgroundTimeoutMs(1)).toBe(1);
    expect(normalizeBackgroundTimeoutMs(9_999.6)).toBe(9_999);
  });

  it("reports an absent or unusable background timeout as undefined", () => {
    // undefined leaves the host's processJobs budget in force rather than
    // substituting the foreground default.
    for (const value of [undefined, null, 0, -1, Number.NaN, Infinity, "nope"]) {
      expect(normalizeBackgroundTimeoutMs(value)).toBeUndefined();
    }
  });

  it("keeps legacy seconds semantics for a background timeout without capping it", () => {
    expect(normalizeBackgroundBashTimeoutMs(30)).toBe(30_000);
    expect(normalizeBackgroundBashTimeoutMs(600)).toBe(600_000);
    expect(normalizeBackgroundBashTimeoutMs(14_400_000)).toBe(14_400_000);
    expect(normalizeBackgroundBashTimeoutMs(undefined)).toBeUndefined();
  });

  it("glob excludes generated and vendor paths by default", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "app.ts"), "source");
    writeFile(join(root, "node_modules", "pkg", "index.js"), "vendor");
    writeFile(join(root, "dist", "assets", "app.js"), "bundle");
    writeFile(join(root, "src", "app.ts.map"), "sourcemap");

    const result = await globToolImpl({ path: root, pattern: "**/*" }, { ctx });

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

    const result = await globToolImpl({ path: root, pattern: "**/*", max_matches: 2 }, { ctx });

    expect((result.match(/src\/file-/g) || [])).toHaveLength(2);
    expect(result).toContain("[truncated Glob result: showing 2 of 5 lines");
  });

  it("uses the packaged ripgrep binary when PATH does not provide rg", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "packaged.ts"), "packaged needle");
    process.env.PATH = "";
    resolveRgPath({ ctx, refresh: true });

    const globResult = await globToolImpl({ path: root, pattern: "src/*.ts" }, { ctx });
    const grepResult = await grepToolImpl({ path: root, pattern: "packaged needle" }, { ctx });

    expect(globResult).toContain("src/packaged.ts");
    expect(grepResult).toContain("src/packaged.ts");
  });

  it("grep excludes generated and vendor paths and caps output", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "one.ts"), "needle one");
    writeFile(join(root, "src", "two.ts"), "needle two");
    writeFile(join(root, "node_modules", "pkg", "index.js"), "needle vendor");
    writeFile(join(root, "dist", "bundle.js"), "needle bundle");
    writeFile(join(root, "src", "bundle.js.map"), "needle map");

    const result = await grepToolImpl({ path: root, pattern: "needle", max_matches: 1 }, { ctx });

    expect(result).toMatch(/src\/(one|two)\.ts/);
    expect(result).not.toContain("/node_modules/");
    expect(result).not.toContain("dist/bundle");
    expect(result).not.toContain("bundle.js.map");
    expect(result).toContain("[truncated Grep result: showing 1 of 2 lines");
  });

  it("resolves relative file paths and shell commands from the configured workspace", async () => {
    const root = tempWorkspace();

    const writeResult = await writeToolImpl({ file_path: "src/relative.txt", content: "hello" }, { ctx });
    const readResult = await readToolImpl({ file_path: "src/relative.txt" }, { ctx });
    const bashResult = await bashToolImpl({ command: "pwd && test -f src/relative.txt && echo ok" }, { ctx });

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

    const writeResult = await writeToolImpl({ file_path: "src/new.txt", content: "new", workdir: project }, { ctx });
    const readResult = await readToolImpl({ file_path: "src/project.txt", workdir: project }, { ctx });
    const globResult = await globToolImpl({ path: ".", pattern: "src/*.txt", workdir: project }, { ctx });
    const bashResult = await bashToolImpl({ command: "pwd && test -f src/project.txt && echo ok", workdir: project }, { ctx });

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

    const first = await readToolImpl({ file_path: "src/large.txt" }, { ctx });
    const second = await readToolImpl({ file_path: "src/large.txt" }, { ctx });

    expect(first).toContain("240\tline 240");
    expect(first).not.toContain("241\tline 241");
    expect(first).toContain("Next unread line: 241");
    expect(second).toContain("already read");
  });

  it("reads PNG files as an image result instead of line-numbered text", async () => {
    const root = tempWorkspace();
    const pngBytes = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
    }).png().toBuffer();
    writeFileSync(join(root, "shot.png"), pngBytes);

    const result = await readToolImpl({ file_path: "shot.png" }, { ctx });

    expect(typeof result).not.toBe("string");
    expect(result.kind).toBe("image");
    expect(result.mimeType).toBe("image/png");
    expect(result.data).toBe(pngBytes.toString("base64"));
  });

  it("reads JPEG files as image/jpeg content", async () => {
    const root = tempWorkspace();
    const jpgBytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 80, g: 100, b: 120 } },
    }).jpeg().toBuffer();
    writeFileSync(join(root, "photo.JPG"), jpgBytes);

    const result = await readToolImpl({ file_path: "photo.JPG" }, { ctx });

    expect(result.kind).toBe("image");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data).toBe(jpgBytes.toString("base64"));
  });

  it("normalizes image edges above 8,000 px without modifying the source file", async () => {
    const root = tempWorkspace();
    const sourcePath = join(root, "tall.png");
    const pngBytes = await sharp({
      create: { width: 4, height: 8_001, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
    }).png().toBuffer();
    writeFileSync(sourcePath, pngBytes);

    const result = await readToolImpl({ file_path: "tall.png" }, { ctx });
    const normalized = Buffer.from(result.data, "base64");
    const metadata = await sharp(normalized).metadata();

    expect(result.kind).toBe("image");
    expect(result.mimeType).toBe("image/png");
    expect(metadata.width).toBe(4);
    expect(metadata.height).toBe(8_000);
    expect(normalized.equals(pngBytes)).toBe(false);
    expect(readFileSync(sourcePath).equals(pngBytes)).toBe(true);
  });

  it.each([
    ["JPEG", "jpg", "jpeg", "image/jpeg"],
    ["WebP", "webp", "webp", "image/webp"],
  ])("preserves %s format when normalizing", async (_label, extension, format, mimeType) => {
    const root = tempWorkspace();
    const source = sharp({
      create: { width: 2, height: 8_001, channels: 3, background: { r: 80, g: 100, b: 120 } },
    });
    const imageBytes = await source.toFormat(format).toBuffer();
    writeFileSync(join(root, `tall.${extension}`), imageBytes);

    const result = await readToolImpl({ file_path: `tall.${extension}` }, { ctx });
    const metadata = await sharp(Buffer.from(result.data, "base64")).metadata();

    expect(result.mimeType).toBe(mimeType);
    expect(metadata.format).toBe(format);
    expect(metadata.height).toBe(8_000);
  });

  it("preserves all frames when normalizing animated GIF images", async () => {
    const root = tempWorkspace();
    const firstFrame = await sharp({
      create: { width: 2, height: 8_001, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    const secondFrame = await sharp({
      create: { width: 2, height: 8_001, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } },
    }).png().toBuffer();
    const gifBytes = await sharp([firstFrame, secondFrame], { join: { animated: true } })
      .gif({ delay: [50, 100], loop: 0 })
      .toBuffer();
    writeFileSync(join(root, "animated.gif"), gifBytes);

    const result = await readToolImpl({ file_path: "animated.gif" }, { ctx });
    const normalized = Buffer.from(result.data, "base64");
    const metadata = await sharp(normalized, { animated: true }).metadata();

    expect(result.mimeType).toBe("image/gif");
    expect(metadata.pages).toBe(2);
    expect(metadata.pageHeight).toBe(8_000);
  });

  it("converts resized BMP images to PNG", async () => {
    const root = tempWorkspace();
    const width = 2;
    const height = 8_001;
    const bmpBytes = encodeBmp({
      width,
      height,
      data: Buffer.alloc(width * height * 4, 255),
    }).data;
    writeFileSync(join(root, "tall.bmp"), bmpBytes);

    const result = await readToolImpl({ file_path: "tall.bmp" }, { ctx });
    const normalized = Buffer.from(result.data, "base64");
    const metadata = await sharp(normalized).metadata();

    expect(result.mimeType).toBe("image/png");
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(8_000);
  });

  it("returns an actionable Read error for undecodable image files", async () => {
    const root = tempWorkspace();
    writeFileSync(join(root, "broken.png"), Buffer.from("not an image"));

    const result = await readToolImpl({ file_path: "broken.png" }, { ctx });

    expect(result).toMatch(/^Error: Unable to read image broken\.png:/);
  });

  it("still reads non-image files as line-numbered text", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "note.txt"), "hello world");

    const result = await readToolImpl({ file_path: "src/note.txt" }, { ctx });

    expect(typeof result).toBe("string");
    expect(result).toContain("1\thello world");
  });

  it("supports bounded grep output modes", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "one.ts"), "needle one");
    writeFile(join(root, "src", "two.ts"), "needle two");

    const filesOnly = await grepToolImpl({ path: root, pattern: "needle", max_matches: 1 }, { ctx });
    const content = await grepToolImpl({ path: root, pattern: "needle", output_mode: "content", head_limit: 2 }, { ctx });

    expect(filesOnly).toMatch(/src\/(one|two)\.ts/);
    expect(filesOnly).not.toContain("needle one");
    expect(content).toContain("src/one.ts:1:needle one");
    expect(content).toContain("src/two.ts:1:needle two");
  });

  it("keeps bash head and tail when truncating large output", async () => {
    const root = tempWorkspace();
    const dataDir = mkdtempSync(resolve("/tmp", "agent-runtime-tool-artifacts-"));
    tempDirs.push(dataDir);
    updateToolContext(ctx, { toolArtifactDir: dataDir, runId: "run-tools" });

    const result = await bashToolImpl({
      command: "printf 'HEAD'; printf '%04000d' 0; printf 'TAIL'",
      max_output_chars: 500,
      workdir: root,
    }, { ctx });

    expect(result).toContain("HEAD");
    expect(result).toContain("TAIL");
    expect(result).toContain("Full output saved to:");
  });

  it("routes bash execution through the configured sandbox engine", async () => {
    const root = tempWorkspace();
    const result = await bashToolImpl(
      { command: "echo unsandboxed", workdir: root },
      { ctx,
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
    }, { ctx });

    expect(result).toContain("Command timed out after 1000ms");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const processes = execFileSync("ps", ["axww", "-o", "command="], { encoding: "utf8" });
    expect(processes).not.toContain(marker);
  });

  it("denies network tools when sandbox policy blocks network", async () => {
    const root = tempWorkspace();
    const sandboxPolicy = failClosedSandboxPolicy({ root });

    const fetchResult = await webFetchToolImpl({ url: "https://example.com" }, { ctx, sandboxPolicy });
    const searchResult = await webSearchToolImpl({ query: "mono agent" }, { ctx, sandboxPolicy });

    expect(fetchResult).toContain("Network access denied by sandbox policy");
    expect(searchResult).toContain("Network access denied by sandbox policy");
  });

  it("rejects non-http WebFetch URLs before calling fetch", async () => {
    const result = await webFetchToolImpl({ url: "file:///etc/passwd" }, { ctx });

    expect(result).toBe("Error: WebFetch only supports http(s) URLs.");
  });

  it("retries a transient WebFetch error and returns the eventual success", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return new Response("recovered body", { status: 200 });
    };
    try {
      const result = await webFetchToolImpl({ url: "https://example.com" }, { ctx, retryDelaysMs: [0, 0] });
      expect(result).toContain("recovered body");
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("gives up after exhausting WebFetch retries on a persistent transient error", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      const err = new Error("read ECONNRESET");
      err.code = "ECONNRESET";
      throw err;
    };
    try {
      const result = await webFetchToolImpl({ url: "https://example.com" }, { ctx, retryDelaysMs: [0, 0] });
      expect(result).toContain("Error fetching URL");
      expect(calls).toBe(3); // initial attempt + 2 retries
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry a non-transient WebFetch error", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("certificate has expired");
    };
    try {
      const result = await webFetchToolImpl({ url: "https://example.com" }, { ctx, retryDelaysMs: [0, 0] });
      expect(result).toBe("Error fetching URL: certificate has expired");
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a clean error when ripgrep is unavailable", async () => {
    const root = tempWorkspace();
    updateToolContext(ctx, { workspace: root, ripgrepPath: join(root, "missing-rg") });
    process.env.PATH = "";
    resolveRgPath({ ctx, refresh: true });

    const globResult = await globToolImpl({ path: root, pattern: "**/*" }, { ctx });
    const grepResult = await grepToolImpl({ path: root, pattern: "needle" }, { ctx });

    expect(globResult).toContain("ripgrep (rg) is not available");
    expect(globResult).not.toContain("ENOENT");
    expect(grepResult).toContain("ripgrep (rg) is not available");
    expect(grepResult).not.toContain("ENOENT");
  });

  it("rejects absolute paths outside the workspace boundary", async () => {
    tempWorkspace();
    const outside = "/etc/agent-runtime-not-real";
    const outsideFile = `${outside}/secret.txt`;

    const readResult = await readToolImpl({ file_path: outsideFile }, { ctx });
    const writeResult = await writeToolImpl({ file_path: `${outside}/new.txt`, content: "x" }, { ctx });
    const editResult = await editToolImpl({ file_path: outsideFile, old_string: "do", new_string: "x" }, { ctx });
    const globResult = await globToolImpl({ path: outside, pattern: "**/*" }, { ctx });
    const grepResult = await grepToolImpl({ path: outside, pattern: "do" }, { ctx });

    expect(readResult).toContain("Path not allowed");
    expect(writeResult).toContain("Path not allowed");
    expect(editResult).toContain("Path not allowed");
    expect(globResult).toContain("Path not allowed");
    expect(grepResult).toContain("Path not allowed");
  });

  it("allows configured file-tool roots without admitting unrelated or symlink-escaped paths", async () => {
    const workspace = tempWorkspace();
    const ownedWorktrees = mkdtempSync(join(homedir(), ".mono-agent-owned-worktrees-"));
    const mainCheckout = mkdtempSync(join(homedir(), ".mono-agent-main-checkout-"));
    const unrelated = mkdtempSync(join(homedir(), ".mono-agent-unrelated-"));
    tempDirs.push(ownedWorktrees, mainCheckout, unrelated);
    writeFile(join(ownedWorktrees, "feature", "source.ts"), "owned needle");
    writeFile(join(mainCheckout, "source.ts"), "main needle");
    writeFile(join(unrelated, "secret.ts"), "outside needle");
    symlinkSync(unrelated, join(ownedWorktrees, "escaped"), "dir");

    updateToolContext(ctx, {
      workspace,
      additionalReadRoots: [mainCheckout, ownedWorktrees],
      additionalWriteRoots: [ownedWorktrees],
    });

    expect(await grepToolImpl({ path: ownedWorktrees, pattern: "owned needle" }, { ctx }))
      .toContain("feature/source.ts");
    expect(await readToolImpl({ file_path: join(mainCheckout, "source.ts") }, { ctx }))
      .toContain("main needle");
    expect(await writeToolImpl({ file_path: join(ownedWorktrees, "feature", "new.ts"), content: "ok" }, { ctx }))
      .toContain("Successfully wrote");
    expect(await writeToolImpl({ file_path: join(mainCheckout, "new.ts"), content: "no" }, { ctx }))
      .toContain("Path not allowed");
    expect(await grepToolImpl({ path: unrelated, pattern: "outside needle" }, { ctx }))
      .toContain("Path not allowed");
    expect(await grepToolImpl({ path: join(ownedWorktrees, "escaped"), pattern: "outside needle" }, { ctx }))
      .toContain("Path not allowed");
  });

  it("uses sandbox policy roots instead of permissive default roots", async () => {
    const root = tempWorkspace();
    const outsideTmpFile = join(resolve("/tmp"), `mono-agent-outside-${process.pid}.txt`);
    writeFile(outsideTmpFile, "outside");

    updateToolContext(ctx, {
      workspace: root,
      additionalReadRoots: [resolve("/tmp")],
      additionalWriteRoots: [resolve("/tmp")],
      sandboxPolicy: failClosedSandboxPolicy({ root }),
    });

    const readResult = await readToolImpl({ file_path: outsideTmpFile }, { ctx });
    const bashResult = await bashToolImpl({ command: "pwd", workdir: "/tmp" }, { ctx });

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

    const readResult = await readToolImpl({ file_path: rootFile }, { ctx, sandboxPolicy });
    const writeResult = await writeToolImpl({ file_path: join(root, "new.txt"), content: "x" }, { ctx, sandboxPolicy });
    const bashResult = await bashToolImpl({ command: "pwd", workdir: root }, { ctx, sandboxPolicy });

    expect(readResult).toContain("Path not allowed");
    expect(writeResult).toContain("Path not allowed");
    expect(bashResult).toContain("Working directory not allowed");
  });

  it("applies per-call sandbox policy to file and shell tools", async () => {
    const root = tempWorkspace();
    const outsideTmpFile = join(resolve("/tmp"), `mono-agent-outside-call-${process.pid}.txt`);
    writeFile(outsideTmpFile, "outside");
    const sandboxPolicy = failClosedSandboxPolicy({ root });

    const readResult = await readToolImpl({ file_path: outsideTmpFile }, { ctx, sandboxPolicy });
    const writeResult = await writeToolImpl({ file_path: outsideTmpFile, content: "x" }, { ctx, sandboxPolicy });
    const globResult = await globToolImpl({ path: "/tmp", pattern: "**/*" }, { ctx, sandboxPolicy });
    const grepResult = await grepToolImpl({ path: "/tmp", pattern: "outside" }, { ctx, sandboxPolicy });
    const bashResult = await bashToolImpl({ command: "pwd", workdir: "/tmp" }, { ctx, sandboxPolicy });

    expect(readResult).toContain("Path not allowed");
    expect(writeResult).toContain("Path not allowed");
    expect(globResult).toContain("Path not allowed");
    expect(grepResult).toContain("Path not allowed");
    expect(bashResult).toContain("Working directory not allowed");
  });

  it("enforces a context-configured sandbox policy on bash and network tools without per-call options", async () => {
    const root = tempWorkspace();
    updateToolContext(ctx, {
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({ root }),
    });

    const fetchResult = await webFetchToolImpl({ url: "https://example.com" }, { ctx });
    const searchResult = await webSearchToolImpl({ query: "mono agent" }, { ctx });
    const bashResult = await bashToolImpl(
      { command: "echo host", workdir: root },
      { ctx,
        sandboxEngine: {
          id: "fake",
          async isAvailable() {
            return true;
          },
          async prepareCommand(command) {
            return {
              ...command,
              command: process.execPath,
              args: ["-e", "console.log('context sandboxed')"],
              sandboxed: true,
            };
          },
        },
      },
    );

    expect(fetchResult).toContain("Network access denied by sandbox policy");
    expect(searchResult).toContain("Network access denied by sandbox policy");
    expect(bashResult).toContain("context sandboxed");
  });

  it("does not let a per-call policy weaken the context-configured sandbox policy", async () => {
    const root = tempWorkspace();
    updateToolContext(ctx, {
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({ root }),
    });

    const fetchResult = await webFetchToolImpl(
      { url: "https://example.com" },
      { ctx, sandboxPolicy: { mode: "off" } },
    );

    expect(fetchResult).toContain("Network access denied by sandbox policy");
  });

  it("rejects symlink escapes when sandbox policy is configured", async () => {
    const root = tempWorkspace();
    const outside = mkdtempSync(resolve("/tmp", "mono-agent-outside-"));
    tempDirs.push(outside);
    writeFile(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "linked-outside"));

    updateToolContext(ctx, {
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({ root }),
    });

    const readResult = await readToolImpl({ file_path: "linked-outside/secret.txt" }, { ctx });

    expect(readResult).toContain("Path not allowed");
  });

  it("rejects protected roots and aliases while sibling reads, writes, and searches remain available", async () => {
    const root = tempWorkspace();
    const privateRoot = join(root, ".mono-agent");
    const stateDir = join(privateRoot, "process-jobs");
    const secretPath = join(stateDir, "process-jobs-secret");
    const siblingPath = join(root, "notes.txt");
    const aliasSecretPath = join(root, "jobs-alias", "process-jobs-secret");
    mkdirSync(stateDir, { recursive: true });
    writeFile(secretPath, "EXACT_PROCESS_JOB_SECRET");
    writeFile(siblingPath, "sibling-readable");
    writeFile(join(privateRoot, "artifacts", "attachments", "input.txt"), "attachment-readable");
    symlinkSync(stateDir, join(root, "jobs-alias"));
    updateToolContext(ctx, {
      sandboxEngine: {
        async isAvailable() { return true; },
        async prepareCommand(command) {
          if ((command.args ?? []).some((arg) => arg === secretPath || arg === aliasSecretPath)) {
            return {
              command: process.execPath,
              args: ["--input-type=commonjs", "--eval", "process.exit(73)"],
              cwd: root,
              sandboxed: true,
            };
          }
          return { ...command, args: command.args ?? [], cwd: command.cwd ?? root, sandboxed: true };
        },
      },
    });
    const sandboxPolicy = failClosedSandboxPolicy({ root, protectedRoots: [stateDir] });

    const readResult = await readToolImpl({ file_path: secretPath }, { ctx, sandboxPolicy });
    const aliasReadResult = await readToolImpl({ file_path: aliasSecretPath }, { ctx, sandboxPolicy });
    const writeResult = await writeToolImpl({ file_path: join(stateDir, "records", "job.json"), content: "bad" }, { ctx, sandboxPolicy });
    const bashResult = await bashToolImpl({ command: "pwd", workdir: stateDir }, { ctx, sandboxPolicy });
    const execResult = await execToolImpl({ executable: "/bin/pwd", workdir: stateDir }, { ctx, sandboxPolicy });
    const siblingRead = await readToolImpl({ file_path: siblingPath }, { ctx, sandboxPolicy });
    const siblingWrite = await writeToolImpl({ file_path: join(root, "sibling-output.txt"), content: "ok" }, { ctx, sandboxPolicy });
    const attachmentRead = await readToolImpl({ file_path: join(privateRoot, "artifacts", "attachments", "input.txt") }, { ctx, sandboxPolicy });
    const globResult = await globToolImpl({ pattern: "**/*", path: root }, { ctx, sandboxPolicy });
    const grepResults = await Promise.all([
      "content",
      "files_with_matches",
      "count",
      undefined,
    ].map(async (output_mode) => await grepToolImpl({
      pattern: "EXACT_PROCESS_JOB_SECRET|sibling-readable",
      path: root,
      ...(output_mode === undefined ? {} : { output_mode }),
    }, { ctx, sandboxPolicy })));

    expect(readResult).toBe("Error: Protected filesystem read was denied.");
    expect(aliasReadResult).toBe("Error: Protected filesystem read was denied.");
    expect(writeResult).toBe("Error: Protected filesystem write was denied.");
    expect(bashResult).toContain("Working directory not allowed");
    expect(execResult).toContain("Working directory not allowed");
    expect([readResult, aliasReadResult, writeResult, bashResult, execResult].join("\n"))
      .not.toContain("EXACT_PROCESS_JOB_SECRET");
    expect(siblingRead).toContain("sibling-readable");
    expect(siblingWrite).toContain("Successfully wrote");
    expect(attachmentRead).toContain("attachment-readable");
    expect(globResult).not.toContain("process-jobs-secret");
    expect(grepResults[0]).toContain("sibling-readable");
    for (const grepResult of grepResults) {
      expect(grepResult).toContain("notes.txt");
      expect(grepResult).not.toContain("process-jobs-secret");
      expect(grepResult).not.toContain("EXACT_PROCESS_JOB_SECRET");
    }
  });

  it("fails host filesystem tools closed when protected roots lack a real sandbox engine", async () => {
    const root = tempWorkspace();
    const stateDir = join(root, ".mono-agent", "process-jobs");
    const siblingPath = join(root, "notes.txt");
    writeFile(join(stateDir, "process-jobs-secret"), "private");
    writeFile(siblingPath, "unchanged");
    const sandboxPolicy = failClosedSandboxPolicy({ root, protectedRoots: [stateDir] });

    const readResult = await readToolImpl({ file_path: siblingPath }, { ctx, sandboxPolicy });
    const writeResult = await writeToolImpl({ file_path: siblingPath, content: "changed" }, { ctx, sandboxPolicy });
    const editResult = await editToolImpl({
      file_path: siblingPath,
      old_string: "unchanged",
      new_string: "changed",
    }, { ctx, sandboxPolicy });
    const globResult = await globToolImpl({ pattern: "**/*", path: root }, { ctx, sandboxPolicy });
    const grepResult = await grepToolImpl({ pattern: "unchanged", path: root }, { ctx, sandboxPolicy });

    expect(readResult).toBe("Error: Protected filesystem read was denied.");
    expect(writeResult).toBe("Error: Protected filesystem write was denied.");
    expect(editResult).toBe("Error: Protected filesystem edit was denied.");
    expect(globResult).toBe("Error: Protected filesystem search was denied.");
    expect(grepResult).toBe("Error: Protected filesystem search was denied.");
    expect(readFileSync(siblingPath, "utf8")).toBe("unchanged");
  });

  it("keeps following workspace symlinks when no sandbox policy is configured", async () => {
    const root = tempWorkspace();
    const outside = mkdtempSync(join(tmpdir(), "mono-agent-linked-"));
    tempDirs.push(outside);
    writeFile(join(outside, "linked.txt"), "linked content");
    symlinkSync(outside, join(root, "linked-dep"));

    const readResult = await readToolImpl({ file_path: "linked-dep/linked.txt" }, { ctx });

    expect(readResult).toContain("linked content");
  });

  it("runs an empty bash command without sandbox argument validation errors", async () => {
    const root = tempWorkspace();

    const result = await bashToolImpl({ command: "", workdir: root }, { ctx });

    expect(result).toBe("(no output)");
  });

  it("honors sandbox writable roots separately from readable roots", async () => {
    const root = tempWorkspace();
    const readable = mkdtempSync(resolve("/tmp", "mono-agent-readable-"));
    tempDirs.push(readable);
    writeFile(join(readable, "note.txt"), "read only");

    updateToolContext(ctx, {
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({
        root,
        readableRoots: [root, readable],
        writableRoots: [root],
      }),
    });

    const readResult = await readToolImpl({ file_path: join(readable, "note.txt") }, { ctx });
    const writeResult = await writeToolImpl({ file_path: join(readable, "new.txt"), content: "x" }, { ctx });
    const editResult = await editToolImpl({ file_path: join(readable, "note.txt"), old_string: "read", new_string: "write" }, { ctx });

    expect(readResult).toContain("1\tread only");
    expect(writeResult).toContain("Path not allowed");
    expect(editResult).toContain("Path not allowed");
  });

  it("enforces sandbox denyWrite for file tool writes inside writable roots", async () => {
    const root = tempWorkspace();
    writeFile(join(root, ".env"), "TOKEN=old");
    writeFile(join(root, ".env.local"), "TOKEN=local");
    writeFile(join(root, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
    writeFile(join(root, ".git", "hooks", "pre-commit"), "echo old\n");

    const sandboxPolicy = failClosedSandboxPolicy({ root });

    const writeResult = await writeToolImpl({ file_path: ".env", content: "TOKEN=new" }, { ctx, sandboxPolicy });
    const envLocalResult = await writeToolImpl({ file_path: ".env.local", content: "TOKEN=new" }, { ctx, sandboxPolicy });
    const editResult = await editToolImpl({
      file_path: ".git/config",
      old_string: "repositoryformatversion",
      new_string: "changed",
    }, { ctx, sandboxPolicy });
    const hookResult = await editToolImpl({
      file_path: ".git/hooks/pre-commit",
      old_string: "echo old",
      new_string: "echo changed",
    }, { ctx, sandboxPolicy });
    const allowedWriteResult = await writeToolImpl({ file_path: "notes.txt", content: "ok" }, { ctx, sandboxPolicy });

    expect(writeResult).toContain("Path not allowed");
    expect(envLocalResult).toContain("Path not allowed");
    expect(editResult).toContain("Path not allowed");
    expect(hookResult).toContain("Path not allowed");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("TOKEN=old");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("TOKEN=local");
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toContain("repositoryformatversion");
    expect(readFileSync(join(root, ".git", "hooks", "pre-commit"), "utf8")).toContain("echo old");
    expect(allowedWriteResult).toContain("Successfully wrote");
  });

  it("rejects bash workdir outside the workspace boundary", async () => {
    tempWorkspace();

    const result = await bashToolImpl({ command: "pwd", workdir: "/etc/agent-runtime-not-real" }, { ctx });

    expect(result).toContain("Working directory not allowed");
  });
});
