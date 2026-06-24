import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  renderSanitizedContentReport,
  runCheckSanitizedContent,
  scanSanitizedText,
} from "../check-sanitized-content.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("check-sanitized-content", () => {
  it("reports forbidden repo-visible identifiers without printing raw matches", () => {
    const downstreamName = ["personal", "agent"].join("-");
    const operatorName = ["Ro", "bert"].join("");
    const findings = scanSanitizedText(`fixture for ${downstreamName} by ${operatorName}\n`, {
      file: "fixtures/example.md",
    });

    expect(findings).toEqual([
      {
        file: "fixtures/example.md",
        line: 1,
        column: 13,
        label: "downstream-agent-personal",
      },
      {
        file: "fixtures/example.md",
        line: 1,
        column: 31,
        label: "operator-name",
      },
    ]);

    const report = renderSanitizedContentReport(findings);
    expect(report).toContain("fixtures/example.md:1:13 label=downstream-agent-personal");
    expect(report).toContain("fixtures/example.md:1:31 label=operator-name");
    expect(report).not.toContain(downstreamName);
    expect(report).not.toContain(operatorName);
  });

  it("allows public repository URLs that contain the GitHub owner", () => {
    const findings = scanSanitizedText(
      [
        "https://github.com/robertsreberski/mono-agent",
        "https://github.com/robertsreberski/mono-agent/blob/main/README.md",
      ].join("\n"),
      { file: "docs/links.md" },
    );

    expect(findings).toEqual([]);
  });

  it("scans tracked files through git and exits non-zero on findings", async () => {
    const cwd = await tempDir();
    const downstreamName = ["personal", "agent"].join("-");
    await writeFile(join(cwd, "tracked.md"), `audit ../${downstreamName}\n`, "utf8");
    const stdout = sink();
    const stderr = sink();

    const result = await runCheckSanitizedContent({
      cwd,
      stdout,
      stderr,
      runCommand: async (command, args) => {
        expect(command).toBe("git");
        expect(args).toEqual(["ls-files", "-z"]);
        return { status: 0, stdout: "tracked.md\0", stderr: "" };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toContain("tracked.md:1:10 label=downstream-agent-personal");
    expect(stdout.text).not.toContain(downstreamName);
    expect(stderr.text).toBe("");
  });

  it("passes when all tracked text is sanitized", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "tracked.md"), "audit ../local-agent-alpha\n", "utf8");
    const stdout = sink();

    const result = await runCheckSanitizedContent({
      cwd,
      stdout,
      stderr: sink(),
      runCommand: async () => ({ status: 0, stdout: "tracked.md\0", stderr: "" }),
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe("Sanitized content check passed\n");
  });
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "sanitized-content-"));
  tempDirs.push(dir);
  return dir;
}

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
