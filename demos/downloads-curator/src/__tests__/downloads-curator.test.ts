import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { parseDownloadsCuratorArgs } from "../cli.js";
import {
  buildDownloadsCuratorConfig,
  createDownloadsCuratorResponder,
  writeDownloadsCuratorDeploymentFiles,
} from "../downloads-curator.js";

describe("downloads curator demo composition", () => {
  it("builds a Codex-backed responder with Downloads cwd, read-only sandbox, and curated MCP server", async () => {
    const root = await mkdtemp(join(tmpdir(), "downloads-curator-demo-"));
    const downloadsRoot = join(root, "Downloads");
    const stateDir = join(root, "state");
    const identityPath = join(root, "IDENTITY.md");
    const artifactDir = join(root, "artifacts");
    const calls: RuntimeRunOptions[] = [];
    await writeFile(identityPath, "You curate Downloads.", "utf8");

    const responder = await createDownloadsCuratorResponder({
      config: buildDownloadsCuratorConfig({
        cwd: root,
        downloadsRoot,
        stateDir,
        identityPath,
        artifactDir,
        model: "gpt-5.5",
      }),
      runtime: {
        async run(_prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
          calls.push(options);
          return { text: "ok" };
        },
      },
      createRunId: () => "run-downloads",
    });

    const response = await responder.respond({
      conversationId: "downloads",
      text: "clean downloads",
      abortSignal: new AbortController().signal,
    }, { append: async () => undefined });

    expect(response.text).toBe("ok");
    expect(calls[0]).toMatchObject({
      cwd: downloadsRoot,
      executionMode: "cli",
      model: { sdk: "codex", model: "gpt-5.5" },
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    expect(calls[0]?.mcpServers?.downloads_curator).toMatchObject({
      type: "stdio",
      env: {
        DOWNLOADS_CURATOR_ROOT: downloadsRoot,
        DOWNLOADS_CURATOR_STATE_DIR: stateDir,
        DOWNLOADS_CURATOR_CURRENT_USER_MESSAGE: "clean downloads",
      },
    });
  });

  it("writes ignored deployment files without touching Downloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "downloads-curator-deploy-"));
    const downloadsRoot = join(root, "Downloads");
    const files = await writeDownloadsCuratorDeploymentFiles({
      cwd: root,
      downloadsRoot,
      model: "gpt-5.5",
    });

    expect(files.configPath).toBe(join(root, ".mono-agent", "downloads-curator", "downloads-curator.config.json"));
    expect(JSON.parse(await readFile(files.configPath, "utf8"))).toMatchObject({
      runtime: {
        model: "codex:gpt-5.5",
        executionMode: "cli",
        workspace: downloadsRoot,
      },
      traceability: {
        sourceId: "downloads-curator",
      },
    });
    await expect(stat(join(downloadsRoot, "_Curated"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the pnpm argument separator before CLI options", () => {
    expect(parseDownloadsCuratorArgs(["--", "--help"])).toEqual({ help: true });
    expect(parseDownloadsCuratorArgs(["--", "--downloads", "/tmp/Downloads"])).toEqual({
      help: false,
      downloadsRoot: "/tmp/Downloads",
    });
  });
});
