import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const configPath = join(repositoryRoot, ".gitleaks.toml");
const fixturePath = join(
  repositoryRoot,
  "scripts/fixtures/gitleaks/telegram-token-cases.json",
);
const temporaryDirectories = [];
const hasGitleaks = spawnSync("gitleaks", ["version"], {
  encoding: "utf8",
}).status === 0;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Telegram token gitleaks rule", () => {
  it("matches only the exact documented token shape", async () => {
    const { config, fixture, fixtureSource } = await readInputs();
    const rule = readRule(config, "telegram-bot-token");
    const pattern = new RegExp(rule.regex, "u");

    expect(rule.secretGroup).toBe(1);

    for (const testCase of fixture.detected) {
      expect(
        pattern.test(JSON.stringify({ candidate: materialize(testCase) })),
        `${testCase.name} should match`,
      ).toBe(true);
    }

    for (const testCase of fixture.ignored) {
      expect(
        pattern.test(JSON.stringify({ candidate: materialize(testCase) })),
        `${testCase.name} should not match`,
      ).toBe(false);
    }

    for (const testCase of [...fixture.detected, ...fixture.ignored]) {
      expect(fixtureSource).not.toContain(materialize(testCase));
    }
  });

  it.skipIf(!hasGitleaks)(
    "flags planted synthetic tokens without flagging near misses",
    async () => {
      const { fixture } = await readInputs();
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "mono-agent-gitleaks-telegram-"),
      );
      temporaryDirectories.push(temporaryDirectory);

      const detectedPath = join(temporaryDirectory, "detected.jsonl");
      const ignoredPath = join(temporaryDirectory, "ignored.jsonl");
      const reportPath = join(temporaryDirectory, "gitleaks-report.json");

      await writeFile(detectedPath, toJsonLines(fixture.detected), "utf8");
      await writeFile(ignoredPath, toJsonLines(fixture.ignored), "utf8");

      const result = spawnSync(
        "gitleaks",
        [
          "dir",
          "--redact",
          "--no-banner",
          "--config",
          configPath,
          "--report-format",
          "json",
          "--report-path",
          reportPath,
          "--exit-code",
          "17",
          temporaryDirectory,
        ],
        { encoding: "utf8" },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(17);

      const report = JSON.parse(await readFile(reportPath, "utf8"));
      expect(report).toHaveLength(fixture.detected.length);
      expect(report.map((finding) => finding.RuleID)).toEqual([
        "telegram-bot-token",
        "telegram-bot-token",
      ]);
      expect(report.map((finding) => basename(finding.File))).toEqual([
        "detected.jsonl",
        "detected.jsonl",
      ]);
    },
  );
});

async function readInputs() {
  const [config, fixtureSource] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(fixturePath, "utf8"),
  ]);

  return {
    config,
    fixture: JSON.parse(fixtureSource),
    fixtureSource,
  };
}

function readRule(config, id) {
  const block = config
    .split("[[rules]]")
    .slice(1)
    .map((section) => section.split(/\n\[\[/u, 1)[0])
    .find((section) => new RegExp(`^\\s*id\\s*=\\s*"${id}"\\s*$`, "mu").test(section));

  if (!block) {
    throw new Error(`Missing [[rules]] block with id ${id}`);
  }

  const regex = /^\s*regex\s*=\s*'''([\s\S]*?)'''\s*$/mu.exec(block)?.[1];
  const secretGroup = /^\s*secretGroup\s*=\s*(\d+)\s*$/mu.exec(block)?.[1];

  if (!regex || secretGroup === undefined) {
    throw new Error(`Rule ${id} must define regex and secretGroup`);
  }

  return { regex, secretGroup: Number(secretGroup) };
}

function materialize(testCase) {
  const { character, count, suffix } = testCase.tail;
  return `${testCase.id}:${character.repeat(count)}${suffix}`;
}

function toJsonLines(testCases) {
  return `${testCases
    .map((testCase) => JSON.stringify({ candidate: materialize(testCase) }))
    .join("\n")}\n`;
}
