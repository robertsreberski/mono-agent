// Contracts for the public example agent shown on the homepage.
//
// The folder under src/example-agent/payments-maintainer/ is a real agent
// folder: `mono-agent validate` (v0.27.1) passes on a copy of it. The page
// imports its files at build time, so these tests pin the folder itself, its
// git hygiene, and the byte-for-byte rendering in dist/.
//
// Run after `pnpm run build` (from marketing/): pnpm run test:unit
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const MARKETING = fileURLToPath(new URL("../", import.meta.url));
const ROOT = join(MARKETING, "src/example-agent/payments-maintainer");
const manifest = JSON.parse(readFileSync(join(MARKETING, "src/example-agent/manifest.json"), "utf8"));
const html = existsSync(join(MARKETING, "dist/index.html")) ? readFileSync(join(MARKETING, "dist/index.html"), "utf8") : "";
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// The approved example's bytes. The only edit since design review is the
// config's `$schema`, which now names the hosted schema.
const APPROVED = {
  ".env.example": "9a4112555664077c11bc8c1569c1c357ccf28f62e5d5bd73f6649fd2d2da2057",
  ".gitignore": "16d02547b98ce549fda55612ae0aa077e9184dd6d72aff38388bfb8057528dea",
  "IDENTITY.md": "cad45af423eb5c8c8012e45a875f2438a3dbfadf381d3041a43e93f71e6053b5",
  "cron/morning-check.md": "032e91c6d2bc5ba19a063180116739fb561c2ce987973863b47c49fb77595ec7",
  "mcp.json": "3d1e71b74eacf7fec0895d9c76b04066836afd7d89e0f4d9994bb43ae0a442d7",
  "mono-agent.config.json": "d95379d2915c82458a10aad1113296159d5fddcc8d57eb8f3d40b7cbf5f2ef27",
  "scratch/README.md": "48459008b895c994aa40b927bb64ec822f53c282a83e9449a041071aed22ee4f",
  "skills/flaky-tests/SKILL.md": "505b2930a87875f5a7080799ec6c2a1261d211fa4f7d5592f63a1a3520cf2c28",
  "skills/triage/SKILL.md": "7d0ba19c14e193cc6ec2696b666e83baeebd0e7b5e0595d5bbc53d1e497ffc9e",
  "webhook/ci-failed.md": "e517c78a43c518bb6003aee11084ac62c859ddc4f42e19ac1f99f6095fc85084",
};
const FORMER_SCHEMA_URL = "https://raw.githubusercontent.com/robertsreberski/mono-agent/main/packages/app/schema/mono-agent.config.schema.json";

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else out.push(relative(ROOT, path));
  }
  return out;
}

function decode(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("example agent folder", () => {
  const files = manifest.filter((entry) => entry.kind === "file").map((entry) => entry.path);

  it("holds exactly the ten public files, never private runtime state", () => {
    assert.deepEqual(listFiles(ROOT).sort(), [...files].sort());
    assert.equal(files.length, 10);
    assert.ok(!existsSync(join(ROOT, ".mono-agent")), "no runtime state directory");
    assert.ok(!existsSync(join(ROOT, ".env")), "no real key file");
    for (const entry of manifest.filter((item) => item.kind === "private")) {
      assert.ok(!existsSync(join(ROOT, entry.path)), `${entry.path} is described, never shipped`);
    }
  });

  it("keeps the approved bytes; only the config schema URL changed", () => {
    for (const path of files) {
      const text = read(path);
      const approvedText = path === "mono-agent.config.json"
        ? text.replace('"$schema": "https://mono-agent.dev/schema.json"', `"$schema": "${FORMER_SCHEMA_URL}"`)
        : text;
      assert.equal(sha256(approvedText), APPROVED[path], `${path} matches the approved example`);
    }
    assert.equal(JSON.parse(read("mono-agent.config.json")).$schema, "https://mono-agent.dev/schema.json");
  });

  it("carries key names only and keeps keys, history and scratch output out of git", () => {
    for (const line of read(".env.example").trimEnd().split("\n")) {
      assert.match(line, /^(#.*|[A-Z][A-Z0-9_]*=)$/, `.env.example line holds no value: ${line}`);
    }
    assert.equal(read(".gitignore"), ".env\n.mono-agent/\nscratch/*\n!scratch/README.md\n");
    for (const path of files) {
      assert.ok(!/\/(?:Users|home)\/[^/\s"'`]+/.test(read(path)), `${path} has no machine home path`);
      assert.ok(statSync(join(ROOT, path)).size < 4096, `${path} stays a small example`);
    }
  });

  it("is fully tracked despite repository ignore rules", () => {
    // `git check-ignore` exits 1 when no path is ignored.
    let ignored = "";
    try {
      ignored = execFileSync("git", ["check-ignore", ...files], { cwd: ROOT, encoding: "utf8" });
    } catch (error) {
      assert.equal(error.status, 1, String(error.stderr));
    }
    assert.equal(ignored, "", "no example file is ignored");
  });
});

describe("example agent on the built homepage", () => {
  it("renders every file byte-for-byte in the no-JavaScript folder view", () => {
    assert.ok(html, "run `pnpm run build` first");
    const fallback = html.match(/<div class="folder-fallback">([\s\S]*?)<div class="folder-window"/)?.[1] ?? "";
    const rendered = new Map(
      [...fallback.matchAll(/<details data-path="([^"]+)" data-kind="file"[^>]*>[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/g)]
        .map((match) => [decode(match[1]), decode(match[2])]),
    );
    assert.deepEqual([...rendered.keys()].sort(), manifest.filter((entry) => entry.kind === "file").map((entry) => entry.path).sort());
    for (const [path, text] of rendered) assert.equal(text, read(path), `${path} is shown exactly`);
    for (const entry of manifest) {
      assert.ok(fallback.includes(`data-path="${entry.path}" data-kind="${entry.kind}"`), `${entry.path} is listed`);
    }
    const privateRows = [...fallback.matchAll(/<details data-path="([^"]+)" data-kind="private"[^>]*>([\s\S]*?)<\/details>/g)];
    assert.equal(privateRows.length, 2, "both private rows are described");
    for (const [, path, body] of privateRows) assert.ok(!body.includes("<pre"), `${path} shows no contents`);
  });

  it("puts the real cron file on the cover sheet", () => {
    const sheet = html.match(/<div class="sheet-text">[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/)?.[1];
    assert.ok(sheet, "cover sheet renders");
    assert.equal(decode(sheet.replace(/<[^>]+>/g, "")), read("cron/morning-check.md"));
  });
});
