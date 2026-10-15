import { retiredHostImports } from "../lib/retired-host-boundary.mjs";
import { activeStaleReferenceLines, engineRuntimeImports } from "../lib/engine-boundary.mjs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SHIPPED_CHANNEL_IDS,
  packageCatalog,
  shippedChannelIdsFromCatalog,
} from "../package-catalog.mjs";
import {
  ADAPTER_NEUTRAL_SOURCE_DIRS,
  findAdapterNeutralityErrors,
  hardcodedChannelPrefixes,
} from "../lib/adapter-neutrality.mjs";

const SYNTHETIC_CHANNEL_ID = "synthetic-channel";
const TEST_CHANNEL_IDS = shippedChannelIdsFromCatalog([
  ...packageCatalog,
  { category: "communication", channelIds: [SYNTHETIC_CHANNEL_ID] },
]);
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("package architecture adapter-neutrality guard", () => {
  it("catalogs the always-on web console as a publishable operator surface", () => {
    expect(packageCatalog.find((entry) => entry.name === "@mono-agent/web")).toMatchObject({
      dir: "web",
      category: "operator-surface",
      allowedDependencyCategories: ["core", "observability", "communication"],
      publishable: true,
    });
  });

  it("exports shipped channel ids from communication-package catalog metadata", () => {
    const declaredIds = packageCatalog
      .filter((entry) => entry.category === "communication")
      .flatMap((entry) => entry.channelIds ?? []);
    expect(SHIPPED_CHANNEL_IDS).toEqual([...new Set(declaredIds)]);
    expect(TEST_CHANNEL_IDS).toEqual([...SHIPPED_CHANNEL_IDS, SYNTHETIC_CHANNEL_ID]);
  });

  it.each(TEST_CHANNEL_IDS)("detects %s prefix literals and patterns but not the bare id", (channelId) => {
    const escapedForRegex = channelId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const coupledSources = [
      `const id = "${channelId}:target";`,
      `const id = \`${channelId}:\${target}\`;`,
      `const prefix = /^${escapedForRegex}:/u;`,
    ];
    for (const source of coupledSources) {
      expect(hardcodedChannelPrefixes(source, TEST_CHANNEL_IDS)).toEqual([channelId]);
    }
    expect(hardcodedChannelPrefixes(`const channel = "${channelId}";`, TEST_CHANNEL_IDS)).toEqual([]);
  });

  it("does not mistake a shipped id inside a longer identifier for a channel prefix", () => {
    expect(hardcodedChannelPrefixes("const options = { sessionKeepAlive: true };", TEST_CHANNEL_IDS)).toEqual([]);
  });

  for (const sourceDir of ADAPTER_NEUTRAL_SOURCE_DIRS) {
    it.each(TEST_CHANNEL_IDS)(`rejects a %s prefix reintroduced in ${sourceDir}`, async (channelId) => {
      const root = await createNeutralSourceRoot();
      const file = join(root, sourceDir, "prefix.ts");
      await writeFile(file, `export const conversationId = "${channelId}:target";\n`);

      expect(findAdapterNeutralityErrors({ root, channelIds: TEST_CHANNEL_IDS })).toEqual([
        `${sourceDir}/prefix.ts must stay adapter-neutral; hardcodes shipped channel prefix "${channelId}:".`,
      ]);
    });

    it(`excludes tests and fixtures under ${sourceDir}`, async () => {
      const root = await createNeutralSourceRoot();
      const ignoredFiles = [
        join(root, sourceDir, "__tests__", "prefix.ts"),
        join(root, sourceDir, "__fixtures__", "prefix.ts"),
        join(root, sourceDir, "fixtures", "prefix.ts"),
        join(root, sourceDir, "prefix.test.ts"),
        join(root, sourceDir, "prefix.spec.ts"),
      ];
      for (const file of ignoredFiles) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, `export const conversationId = "${SYNTHETIC_CHANNEL_ID}:target";\n`);
      }

      expect(findAdapterNeutralityErrors({ root, channelIds: TEST_CHANNEL_IDS })).toEqual([]);
    });
  }
});

async function createNeutralSourceRoot() {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-architecture-"));
  temporaryRoots.push(root);
  await Promise.all(
    ADAPTER_NEUTRAL_SOURCE_DIRS.map((sourceDir) => mkdir(join(root, sourceDir), { recursive: true })),
  );
  return root;
}


describe("engine ownership and historical reference guard", () => {
  const oldPackage = `@mono-agent/${"harness"}`, oldDirectory = `packages/${"harness"}`;
  it("rejects old names in active source and documentation", () => {
    expect(activeStaleReferenceLines("packages/turn/src/engine/index.js", `import "${oldPackage}";`, oldPackage)).toEqual([1]);
    expect(activeStaleReferenceLines("README.md", oldDirectory, oldDirectory)).toEqual([1]);
  });
  it("exempts only the identified archived import, not additional active lines", () => {
    const file = "packages/turn/src/engine/__tests__/fixtures/projection-parity-worker.mjs";
    const historic = `const historicPackage = "${oldPackage}"; // Archived P2b imports only.`;
    expect(activeStaleReferenceLines(file, historic, oldPackage)).toEqual([]);
    expect(activeStaleReferenceLines(file, `${historic}\nimport "${oldPackage}";`, oldPackage)).toEqual([2]);
    expect(activeStaleReferenceLines("packages/turn/src/engine/index.js", historic, oldPackage)).toEqual([1]);
  });
  it("preserves exact source provenance but rejects active additions in that file", () => {
    const line = `closure of \`${oldDirectory}/src/session-store.js\` at public P2b revision`;
    const text = `${line}\n\`10f501d4f1dc102db9951fcebb09a96001910452\``;
    const file = "packages/turn/src/engine/__tests__/fixtures/NATIVE-V2-BASE.md";
    expect(activeStaleReferenceLines(file, text, oldDirectory)).toEqual([]);
    expect(activeStaleReferenceLines(file, text + `\n${oldDirectory}`, oldDirectory)).toEqual([3]);
    expect(activeStaleReferenceLines(file, line, oldDirectory)).toEqual([1]);
  });
  it.each([
    `  const archive = execFileSync("git", ["archive", base, "${oldDirectory}/src", "packages/agent-runtime/src"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });`,
    `      join(scratch, "${oldDirectory}/src"), join(scratch, "packages/agent-runtime/src"), storage, legacy], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });`,
  ])("exempts only the commit-pinned historical archive line: %s", (line) => {
    const file = "packages/turn/src/engine/__tests__/fixtures/regenerate-projection-goldens.mjs";
    const pinned = 'const base = "10f501d4f1dc102db9951fcebb09a96001910452";';
    expect(activeStaleReferenceLines(file, `${pinned}\n${line}`, oldDirectory)).toEqual([]);
    expect(activeStaleReferenceLines(file, line, oldDirectory)).toEqual([1]);
    const active = line.replace("packages/agent-runtime/src", "packages/turn/src");
    expect(activeStaleReferenceLines(file, `${pinned}\n${active}`, oldDirectory)).toEqual([2]);
    expect(activeStaleReferenceLines("packages/turn/src/engine/index.js", `${pinned}\n${line}`, oldDirectory)).toEqual([2]);
  });
  it("checks static, dynamic and relative engine imports, not just manifests", () => {
    const root = "/fictional", file = root + "/packages/turn/src/engine/index.js";
    for (const specifier of ["@mono-agent/turn", "@mono-agent/turn/ai", "@mono-agent/turn/engine", "@mono-agent/turn/engine/sessions.js", "@mono-agent/contracts", "@mono-agent/conversation/owned.js", "#kernel/cost", "#kernel/types",
      "../index.js", "../ai/index.js", "../../scripts/helper.js", "../../.."]) {
      for (const source of [`import { run } from "${specifier}";`, `export { run } from "${specifier}";`, `await import("${specifier}");`]) {
        expect(engineRuntimeImports(root, file, source)).toEqual([specifier]);
      }
    }
    expect(engineRuntimeImports(root, file, 'import "./session-store.js"; import "./session-store.js"; import "@earendil-works/pi-agent-core"; import "node:fs";')).toEqual([]);
  });
});

describe.each(["@mono-agent/agent-app","@mono-agent/agent-harness","@mono-agent/agent-runtime","@mono-agent/agent-contracts","@mono-agent/slack-adapter","@mono-agent/telegram-adapter","@mono-agent/openai-api-adapter","@mono-agent/operator-adapter","@mono-agent/cron-adapter","@mono-agent/webhook-adapter","@mono-agent/whatsapp-adapter","@mono-agent/messenger-adapter","@mono-agent/a2a-adapter","@mono-agent/agent-orchestrator", "@mono-agent/runtime-adapter", "@mono-agent/engine", "@mono-agent/engine/sessions.js", "@mono-agent/engine/owned-fs.js"])("retired package imports: %s", (old) => {
  it.each([
    `import { createMonoRuntime } from "${old}";`,
    `export * from "${old}";`,
    `import type { RuntimeRunOptions } from "${old}";`,
    `type Options = import("${old}").RuntimeRunOptions;`,
    `const host = await import("${old}");`,
    `const host = require("${old}");`,
  ])("rejects active imports: %s", (text) => {
    expect(retiredHostImports("fixture.ts", text)).toEqual([old]);
  });
  it("permits migration prose and negative package-resolution assertions", () => {
    expect(retiredHostImports("MIGRATION.md", `import { x } from "${old}"`)).toEqual([]);
    expect(retiredHostImports("fixture.ts", `// import x from "${old}"\nassertRemovedImport("${old}");`)).toEqual([]);
  });
});
