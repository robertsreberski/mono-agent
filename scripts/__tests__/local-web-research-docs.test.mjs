import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_PATH = path.resolve(TEST_DIR, "../../docs/playbooks/local-web-research.md");

describe("local web research operator snippets", () => {
  it("rejects an empty SearXNG response when engines are unresponsive in both JSON checks", () => {
    const snippets = jsonVerificationSnippets();
    expect(snippets).toHaveLength(2);

    for (const snippet of snippets) {
      const blocked = runSnippet(snippet, {
        results: [],
        unresponsive_engines: [["yahoo", "CAPTCHA"]],
      });
      expect(blocked.status).not.toBe(0);
      expect(blocked.stdout).not.toContain("JSON API OK");
      expect(blocked.stderr).toContain("empty results with unresponsive engines");

      const healthyEmpty = runSnippet(snippet, { results: [], unresponsive_engines: [] });
      expect(healthyEmpty.status).toBe(0);
      expect(healthyEmpty.stdout).toContain("JSON API OK: 0 result(s)");
    }
  });

  it("pins the Compose project name on every operator command", () => {
    const playbook = readFileSync(PLAYBOOK_PATH, "utf8");
    const composeCommands = playbook.split("\n").filter((line) => line.includes("docker compose"));

    expect(composeCommands).toHaveLength(9);
    expect(composeCommands.every((line) =>
      line.includes("docker compose --project-name mono-agent-searxng"))).toBe(true);
  });
});

function jsonVerificationSnippets() {
  const playbook = readFileSync(PLAYBOOK_PATH, "utf8");
  return [...playbook.matchAll(/\| node --input-type=module -e '\n([\s\S]*?)\n'/gu)]
    .map((match) => match[1]);
}

function runSnippet(source, response) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    input: JSON.stringify(response),
  });
}
