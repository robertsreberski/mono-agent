import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

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

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot(), path), "utf8");
}

function section(page: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = page.indexOf(marker);
  if (start === -1) {
    throw new Error(`missing section ${marker}`);
  }
  const rest = page.slice(start + marker.length);
  const next = rest.search(/^## /mu);
  return next === -1 ? rest : rest.slice(0, next);
}

function firstJsonBlock(page: string): unknown {
  const match = page.match(/```json\n([\s\S]*?)\n```/u);
  if (match?.[1] === undefined) {
    throw new Error("missing JSON code block");
  }
  return JSON.parse(match[1]);
}

describe("mono-agent-composer reference parity", () => {
  const registry = readRepoFile("docs/reference/feature-registry.md");
  const matrix = readRepoFile("docs/reference/feature-matrix.md");
  const coverage = readRepoFile(
    "packages/agent-app/skills/mono-agent-composer/references/feature-coverage.md",
  );
  const blueprint = readRepoFile(
    "packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md",
  );
  const packageMap = readRepoFile(
    "packages/agent-app/skills/mono-agent-composer/references/package-map.md",
  );
  const composerPlaybooks = readRepoFile(
    "packages/agent-app/skills/mono-agent-composer/references/playbooks.md",
  );

  it("registers the two previously prose-only capabilities in both canonical tables", () => {
    for (const id of ["memory.backend-supermemory", "interaction.bridge"]) {
      const rowPrefix = `| \`${id}\` |`;
      expect(registry, `feature registry is missing ${id}`).toContain(rowPrefix);
      expect(matrix, `feature matrix is missing ${id}`).toContain(rowPrefix);
    }
  });

  it("keeps every audited config and CLI anchor in the exhaustive feature coverage", () => {
    const anchors = [
      "runtime.routeSafety",
      "concurrency.maxConcurrentRuns",
      "concurrency.maxPendingRuns",
      'memory.backend: "supermemory"',
      "memory.supermemory.{baseUrl,apiKey,apiKeyEnv,container,timeoutMs,exposeMcpServer}",
      "interaction.bridge.{host,port}",
      "interaction.askUser.timeoutMs",
      "interaction.progress.enabled",
      "cron.jobs[].{model,effort}",
      "webhook.endpoints[].{model,effort}",
      "notifyConversationId",
      "notifyFailureCooldownHours",
      "--show-auth-url",
      "--max-runs <n>",
      "MONO_AGENT_WEB_AUTH_TOKEN",
      "@mono-agent/session-web",
    ];

    for (const anchor of anchors) {
      expect(coverage, `feature coverage is missing ${anchor}`).toContain(anchor);
    }
  });

  it("keeps the annotated config blueprint complete for audited config keys", () => {
    const anchors = [
      '"routeSafety": "uniform"',
      "none|minimal|low|medium|high|xhigh|max|ultra",
      '"maxConcurrentRuns"',
      '"maxPendingRuns"',
      '"backend": "bujo"',
      '"supermemory"',
      '"baseUrl"',
      '"apiKey"',
      '"apiKeyEnv"',
      '"container"',
      '"timeoutMs"',
      '"exposeMcpServer"',
      '"interaction"',
      '"bridge"',
      '"askUser"',
      '"progress"',
      '"endpoints"',
      '"model"',
      '"effort"',
      '"notify"',
      '"notifyConversationId"',
      '"notifyFailureCooldownHours"',
    ];

    for (const anchor of anchors) {
      expect(blueprint, `config blueprint is missing ${anchor}`).toContain(anchor);
    }
  });

  it("maps the optional memory backend and browser surface to their owning packages", () => {
    expect(packageMap).toContain("@mono-agent/memory-supermemory");
    expect(packageMap).toContain('memory.backend: "supermemory"');
    expect(packageMap).toContain("@mono-agent/session-web");
  });

  it("mirrors the canonical native-notify playbook without a send-tool workaround", () => {
    const composerSection = section(composerPlaybooks, "6. Cron digest with native notify");
    const canonicalPlaybook = readRepoFile("docs/playbooks/cron-digest-proactive-notify.md");

    expect(firstJsonBlock(composerSection)).toEqual(firstJsonBlock(canonicalPlaybook));
    expect(composerSection).toContain("`channel.native-notify`");
    expect(composerSection).toContain('`notify: true`');
    expect(composerSection).toContain("no tool call");
    expect(composerSection).not.toContain("SlackSendMessage");
  });
});
