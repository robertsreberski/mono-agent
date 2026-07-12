import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadOpenAIApiAdapterConfig } from "@mono-agent/openai-api-adapter";

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this test until the pnpm workspace root (the dir with pnpm-workspace.yaml). */
function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml above the test file");
}

const ENV_KEY_PATTERN = /MONO_AGENT_[A-Z0-9_]+/gu;

function envKeysIn(source: string): string[] {
  return [...source.matchAll(ENV_KEY_PATTERN)].map((match) => match[0]);
}

/** Every `MONO_AGENT_*` literal the loader + all adapters actually read. */
function codeEnvKeys(root: string): Set<string> {
  const files: string[] = [
    join(root, "packages/config/src/config.ts"),
    join(root, "packages/config/src/layered-loader.ts"),
    // App-level loaders that read their own MONO_AGENT_* keys outside the core config.
    join(root, "packages/agent-app/src/interaction-bridge.ts"),
    join(root, "packages/agent-app/src/adapter-send-tools.ts"),
    join(root, "packages/agent-app/src/web-command.ts"),
  ];
  for (const workspaceRoot of ["packages", "extras"]) {
    const workspaceDir = join(root, workspaceRoot);
    if (!existsSync(workspaceDir)) {
      continue;
    }
    for (const entry of readdirSync(workspaceDir)) {
      if (entry.endsWith("-adapter")) {
        files.push(...adapterConfigFiles(join(workspaceDir, entry, "src")));
      }
    }
  }
  const keys = new Set<string>();
  for (const file of files) {
    for (const key of envKeysIn(readFileSync(file, "utf8"))) {
      keys.add(key);
    }
  }
  return keys;
}

function adapterConfigFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...adapterConfigFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name === "config.ts") {
      files.push(path);
    }
  }
  return files;
}

describe("env-vars.md <-> code parity", () => {
  const root = repoRoot();
  const code = codeEnvKeys(root);
  // Both the canonical docs tree and the published website mirror must stay honest.
  const docPaths = [
    join(root, "docs/config/env-vars.md"),
    join(root, "website/src/content/docs/config/env-vars.md"),
  ].filter((path) => existsSync(path));

  it("has at least the canonical docs file to check", () => {
    expect(docPaths.length).toBeGreaterThan(0);
  });

  it("keeps the documented OpenAI API port default aligned with runtime", async () => {
    const channelDoc = readFileSync(join(root, "docs/channels/openai-api.md"), "utf8");
    const defaults = await loadOpenAIApiAdapterConfig({ env: {} });
    expect(channelDoc).toContain(`| \`port\` | integer | \`${defaults.port}\` | TCP port`);
  });

  for (const docPath of docPaths) {
    it(`references only real env keys in ${docPath.slice(root.length + 1)}`, () => {
      const docKeys = new Set(envKeysIn(readFileSync(docPath, "utf8")));
      // Trailing-underscore tokens are prose wildcards like `MONO_AGENT_TRACE_*`
      // and `MONO_AGENT_LOCAL_PROVIDER_*`; the regex stops at the `*`.
      const unknown = [...docKeys].filter(
        (key) => !key.endsWith("_") && !code.has(key),
      );
      expect(unknown).toEqual([]);
    });

    it(`documents every OpenAI API env key in ${docPath.slice(root.length + 1)}`, () => {
      const docKeys = new Set(envKeysIn(readFileSync(docPath, "utf8")));
      const openAIApiKeys = [...code].filter((key) => key.startsWith("MONO_AGENT_OPENAI_API_"));
      expect(openAIApiKeys.length).toBeGreaterThan(0);
      expect(openAIApiKeys.filter((key) => !docKeys.has(key))).toEqual([]);
    });
  }
});
