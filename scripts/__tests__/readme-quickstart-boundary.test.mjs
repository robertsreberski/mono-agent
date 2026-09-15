import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function readRepoFile(relativePath) {
  return readFileSync(new URL(relativePath, `file://${repoRoot}/`), "utf8");
}

function topLevelSection(page, heading) {
  const marker = `## ${heading}`;
  const start = page.indexOf(marker);
  if (start === -1) throw new Error(`missing README section: ${heading}`);

  const rest = page.slice(start + marker.length);
  const next = rest.search(/\n## /u);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("root README Quickstart boundary", () => {
  const readme = readRepoFile("README.md");
  const quickstart = topLevelSection(
    readme,
    "Quickstart: An Agent Folder From One Config File",
  );

  it("keeps the complete web-first runnable command flow in order", () => {
    const commands = [
      "npm i -g create-mono-agent",
      "mkdir my-agent",
      "cd my-agent",
      "mono-agent init",
      "mono-agent validate",
      "mono-agent start",
      "mono-agent web start --loopback",
      "http://127.0.0.1:5050",
    ];

    let cursor = -1;
    for (const command of commands) {
      const next = quickstart.indexOf(command, cursor + 1);
      expect(next, `Quickstart is missing the ordered command: ${command}`).toBeGreaterThan(cursor);
      cursor = next;
    }

    expect(quickstart.split("\n").length).toBeLessThanOrEqual(70);
    expect(quickstart).toContain("./docs/getting-started/quickstart.md");
    expect(quickstart).toContain("./docs/reference/setup-security.md");
  });

  it("keeps the first browser conversation the documented path", () => {
    // The beginner path must not require a terminal-only smoke channel or the
    // terminal console: the browser console is the documented first surface.
    expect(quickstart).not.toMatch(/\bcurl\b/u);
    expect(quickstart).not.toMatch(/mono-agent tui\b/u);
    expect(quickstart).not.toMatch(/mono-agent-tui\b/u);
    expect(readme).toContain("./docs/reference/release-status.md");
  });

  it("keeps deep setup internals outside the runnable section", () => {
    const forbiddenInternals = [
      /\bPOSIX\b/u,
      /\bHMAC\b/u,
      /\binode\b/iu,
      /\blifetime lease\b/iu,
      /\bno-clobber\b/iu,
      /\b0600\b/u,
      /\bowner-only\b/iu,
      /\blaunchd\b/iu,
      /\bPID reuse\b/iu,
      /background-snapshot-keys/iu,
      /dependency closure/iu,
      /permission-denied/iu,
    ];

    for (const pattern of forbiddenInternals) {
      expect(quickstart, `deep internal ${pattern} belongs in the reference page`).not.toMatch(
        pattern,
      );
    }
  });

  it("preserves the moved contracts on the linked canonical reference page", () => {
    const setupSecurity = readRepoFile("docs/reference/setup-security.md");
    const referenceIndex = readRepoFile("docs/reference/index.md");
    const firstAgent = readRepoFile("docs/getting-started/quickstart.md");

    for (const anchor of [
      "POSIX",
      "HMAC",
      "inode",
      "lifetime lease",
      "no-clobber",
      "0600",
      "permission-denied",
    ]) {
      expect(setupSecurity, `setup-security.md is missing moved anchor: ${anchor}`).toContain(
        anchor,
      );
    }

    expect(referenceIndex).toContain("[Setup security and managed runtime](/reference/setup-security/)");
    expect(firstAgent).toContain("[Setup security and managed runtime](/reference/setup-security/)");
  });

  it("keeps the installed-vs-source release status discoverable from the first-read pages", () => {
    const releaseStatus = readRepoFile("docs/reference/release-status.md");
    const install = readRepoFile("docs/getting-started/install.md");
    const referenceIndex = readRepoFile("docs/reference/index.md");

    expect(install).toContain("[Release status](/reference/release-status/)");
    expect(referenceIndex).toContain("[Release status](/reference/release-status/)");
    expect(releaseStatus).toContain("## Source-only capability groups");
    expect(releaseStatus).toContain("## How this page is kept honest");
    expect(releaseStatus).toContain("/getting-started/install/#run-an-unreleased-build");
  });
});
