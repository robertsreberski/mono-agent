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
const ENV_TABLE_KEY_PATTERN = /^\| `(MONO_AGENT_[A-Z0-9_]+)` \|/gmu;
const ADAPTER_ENV_PREFIXES = {
  "a2a-adapter": ["MONO_AGENT_A2A_"],
  "cron-adapter": ["MONO_AGENT_CRON_"],
  "openai-api-adapter": ["MONO_AGENT_OPENAI_API_"],
  "operator-adapter": ["MONO_AGENT_LIVE_", "MONO_AGENT_TUI_"],
  "slack-adapter": ["MONO_AGENT_SLACK_"],
  "telegram-adapter": ["MONO_AGENT_TELEGRAM_"],
  "webhook-adapter": ["MONO_AGENT_WEBHOOK_"],
  "whatsapp-adapter": ["MONO_AGENT_WHATSAPP_"],
} as const;
const JSON_ONLY_ADAPTER_FIELDS = [
  ["slack.shortcuts", "MONO_AGENT_SLACK_SHORTCUTS"],
  ["slack.homeTab", "MONO_AGENT_SLACK_HOME_TAB"],
] as const;
const SHARED_ENV_KEYS_READ_BY_ADAPTERS = new Set(["MONO_AGENT_NAME"]);

function envKeysIn(source: string): string[] {
  return [...source.matchAll(ENV_KEY_PATTERN)].map((match) => match[0]);
}

function envTableKeysIn(source: string): string[] {
  return [...source.matchAll(ENV_TABLE_KEY_PATTERN)].map((match) => match[1] ?? "");
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
    // Harness-owned request capability keys are injected into opted stdio MCPs;
    // they are real runtime env, although operators do not configure them.
    join(root, "packages/agent-harness/src/harness.ts"),
    join(root, "packages/agent-harness/src/harness/mcp-context.ts"),
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
  return concreteEnvKeys(files);
}

function concreteEnvKeys(files: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const file of files) {
    for (const key of envKeysIn(readFileSync(file, "utf8"))) {
      // Prose wildcards such as `MONO_AGENT_CRON_*` stop at the underscore;
      // only concrete keys participate in code↔docs parity.
      if (!key.endsWith("_")) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function adapterCodeEnvKeys(root: string): Set<string> {
  const files: string[] = [];
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
  return concreteEnvKeys(files);
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

/** Discover config-bearing adapter workspaces; the explicit map handles multi-surface adapters. */
function adapterWorkspaces(root: string): string[] {
  const workspaces = new Set<string>();
  for (const workspaceRoot of ["packages", "extras"]) {
    const workspaceDir = join(root, workspaceRoot);
    if (!existsSync(workspaceDir)) {
      continue;
    }
    for (const entry of readdirSync(workspaceDir)) {
      if (!entry.endsWith("-adapter")) {
        continue;
      }
      const configFiles = adapterConfigFiles(join(workspaceDir, entry, "src"));
      if (configFiles.length === 0) {
        continue;
      }
      workspaces.add(entry);
    }
  }
  return [...workspaces].sort();
}

describe("env-vars.md <-> code parity", () => {
  const root = repoRoot();
  const code = codeEnvKeys(root);
  const adapterCode = adapterCodeEnvKeys(root);
  const adapterPrefixes = Object.values(ADAPTER_ENV_PREFIXES).flat().sort();
  // Both the canonical docs tree and the published website mirror must stay honest.
  const docPaths = [
    join(root, "docs/config/env-vars.md"),
    join(root, "website/src/content/docs/config/env-vars.md"),
  ].filter((path) => existsSync(path));

  it("has at least the canonical docs file to check", () => {
    expect(docPaths.length).toBeGreaterThan(0);
  });

  it("discovers every config-bearing adapter env prefix", () => {
    expect(adapterWorkspaces(root)).toEqual(Object.keys(ADAPTER_ENV_PREFIXES).sort());
    expect(
      [...adapterCode].filter(
        (key) => !SHARED_ENV_KEYS_READ_BY_ADAPTERS.has(key)
          && !adapterPrefixes.some((prefix) => key.startsWith(prefix)),
      ),
      "adapter code keys without a registered adapter prefix",
    ).toEqual([]);
    for (const prefix of adapterPrefixes) {
      expect([...adapterCode].filter((key) => key.startsWith(prefix)), prefix).not.toEqual([]);
    }
  });

  it("keeps the documented OpenAI API port default aligned with runtime", async () => {
    const channelDoc = readFileSync(join(root, "docs/channels/openai-api.md"), "utf8");
    const defaults = await loadOpenAIApiAdapterConfig({ env: {} });
    expect(channelDoc).toContain(`| \`port\` | integer | \`${defaults.port}\` | TCP port`);
  });

  it("keeps JSON-only adapter fields explicit instead of inventing env keys", () => {
    const generatedReference = readFileSync(join(root, "docs/config/reference.md"), "utf8");
    const docs = [
      "docs/config/env-vars.md",
      "docs/channels/slack.md",
      "docs/reference/feature-registry.md",
    ].map((path) => [path, readFileSync(join(root, path), "utf8")] as const);

    for (const [jsonPath, nonexistentEnvKey] of JSON_ONLY_ADAPTER_FIELDS) {
      expect(code.has(nonexistentEnvKey), nonexistentEnvKey).toBe(false);
      const referenceRow = generatedReference
        .split("\n")
        .find((line) => line.startsWith(`| \`${jsonPath}\` |`));
      expect(referenceRow, `${jsonPath} must be in the generated config reference`).toBeDefined();
      expect(referenceRow, `${jsonPath} must have no environment mapping`).toContain("| `--` |");
      for (const [path, contents] of docs) {
        expect(contents, `${path} must identify ${jsonPath} as JSON-only`).toContain(jsonPath);
      }
    }
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

    for (const prefix of adapterPrefixes) {
      it(`documents every ${prefix} env key in ${docPath.slice(root.length + 1)}`, () => {
        const tableKeys = envTableKeysIn(readFileSync(docPath, "utf8"));
        const adapterKeys = [...code].filter((key) => key.startsWith(prefix)).sort();
        expect(adapterKeys, prefix).not.toEqual([]);
        expect(
          adapterKeys
            .map((key) => ({ key, rows: tableKeys.filter((tableKey) => tableKey === key).length }))
            .filter(({ rows }) => rows !== 1),
          `${prefix} keys must each have exactly one env-vars table row`,
        ).toEqual([]);
      });
    }
  }
});
