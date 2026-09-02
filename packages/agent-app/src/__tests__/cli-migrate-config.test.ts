import { writeFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateConfigSource, migrateTriggerMarkdown } from "../cli-migrate-config-command.js";
import { runCli } from "../cli.js";

/**
 * A FIFO of one-shot "something else happened right after this read" hooks,
 * matched by path and AWAITED before the read resolves. Interposing here is the
 * only deterministic way to place another writer inside the window between
 * `migrate-config` reading a config and replacing it, and to hold two runs in
 * lock-step across that window instead of hoping the scheduler interleaves
 * them. Everything else about `node:fs/promises` passes straight through.
 */
const fsHooks = vi.hoisted(() => ({
  queue: [] as { readonly path: string; readonly run: () => void | Promise<void> }[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFileWithHook = async (...args: Parameters<typeof actual.readFile>): Promise<unknown> => {
    const contents = await (actual.readFile as (...a: unknown[]) => Promise<unknown>)(...args);
    const index = fsHooks.queue.findIndex((hook) => hook.path === String(args[0]));
    if (index !== -1) {
      const [hook] = fsHooks.queue.splice(index, 1);
      await hook!.run();
    }
    return contents;
  };
  return { ...actual, readFile: readFileWithHook, default: { ...actual, readFile: readFileWithHook } };
});

describe("migrateConfigSource", () => {
  it("deletes runtime.executionMode and memory.llm.executionMode", () => {
    const result = migrateConfigSource(`{
  "runtime": {
    "model": "openai-codex:gpt-5.6-sol",
    "executionMode": "sdk"
  },
  "memory": {
    "mode": "lite",
    "llm": {
      "model": "openai-codex:gpt-5.6-sol",
      "executionMode": "sdk"
    }
  }
}
`);
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "delete", pointer: "runtime.executionMode", before: '"sdk"' }),
      expect.objectContaining({ kind: "delete", pointer: "memory.llm.executionMode", before: '"sdk"' }),
    ]));
    expect(result.output).not.toContain("executionMode");
    expect(result.output).toContain('"llm": {');
  });

  it("deletes runtime.routeSafety", () => {
    const result = migrateConfigSource(`{
  "runtime": {
    "model": "openai-codex:gpt-5.6-sol",
    "routeSafety": "per-route-native"
  }
}
`);
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "delete", pointer: "runtime.routeSafety", before: '"per-route-native"' }),
    ]));
    expect(result.output).not.toContain("routeSafety");
  });

  it("converts runtime.fallbackModels to runtime.fallbacks objects", () => {
    const result = migrateConfigSource(`{
  "runtime": {
    "model": "openai-codex:gpt-5.6-sol",
    "fallbackModels": ["a", "b"]
  }
}
`);
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "rename", pointer: "runtime.fallbacks" }),
    ]));
    expect(result.output).not.toContain("fallbackModels");
    expect(result.output).toContain('"fallbacks"');
    expect(result.output).toContain('"model": "a"');
    expect(result.output).toContain('"model": "b"');
  });

  it("strips a leading pi: from runtime.model, fallbacks[].model, and memory.llm.model", () => {
    const result = migrateConfigSource(`{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-sol",
    "fallbacks": [
      { "model": "pi:anthropic:claude-opus-5" }
    ]
  },
  "memory": {
    "mode": "lite",
    "llm": { "provider": "agent-host", "model": "pi:openai:gpt-4.1-mini" }
  }
}
`);
    expect(result.changed).toBe(true);
    expect(result.output).toContain('"model": "openai-codex:gpt-5.6-sol"');
    expect(result.output).toContain('"model": "anthropic:claude-opus-5"');
    expect(result.output).toContain('"model": "openai:gpt-4.1-mini"');
    expect(result.output).not.toContain("pi:");
  });

  it("applies all four transforms in one file", () => {
    const result = migrateConfigSource(`{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-sol",
    "fallbackModels": ["pi:anthropic:claude-opus-5"],
    "executionMode": "sdk",
    "routeSafety": "per-route-native"
  },
  "memory": {
    "mode": "lite",
    "llm": { "provider": "agent-host", "model": "pi:openai:gpt-4.1-mini", "executionMode": "sdk" }
  }
}
`);
    expect(result.changed).toBe(true);
    expect(result.output).not.toContain("executionMode");
    expect(result.output).not.toContain("routeSafety");
    expect(result.output).not.toContain("fallbackModels");
    expect(result.output).not.toContain("pi:");
    expect(result.output).toContain('"model": "anthropic:claude-opus-5"');
  });

  it("reports non-Pi model references as manual migrations without rewriting them", () => {
    const result = migrateConfigSource(`{
  "runtime": {
    "model": "codex:gpt-5.6-terra",
    "executionMode": "sdk"
  }
}
`);
    expect(result.changed).toBe(true);
    expect(result.manualMigrations).toEqual([{ pointer: "runtime.model", value: "codex:gpt-5.6-terra" }]);
    expect(result.output).toContain('"codex:gpt-5.6-terra"');
    expect(result.output).not.toContain("executionMode");
  });

  it("visits every config-owned model reference, not just runtime and memory", () => {
    // `--check` is a pre-restart gate. Visiting only runtime/memory let it exit
    // 0 while the loader still threw on `subagents.definitions[].model` and the
    // cron/webhook overrides were silently warn-and-ignored at turn time.
    const result = migrateConfigSource(`{
  "runtime": { "model": "openai-codex:gpt-5.6-sol" },
  "subagents": {
    "enabled": true,
    "definitions": [
      { "name": "researcher", "description": "d", "prompt": "p", "model": "pi:anthropic:claude-opus-5" }
    ]
  },
  "cron": {
    "model": "pi:openai:gpt-4.1-mini",
    "jobs": [
      { "id": "digest", "expression": "0 7 * * *", "prompt": "p", "model": "pi:openai-codex:gpt-5.6-luna" }
    ]
  },
  "webhook": {
    "model": "pi:anthropic:claude-sonnet-4-6",
    "endpoints": [
      { "name": "triage", "path": "/t", "model": "pi:openai:gpt-4.1" }
    ]
  }
}
`);

    expect(result.changed).toBe(true);
    expect(result.changes.map((change) => change.pointer)).toEqual(expect.arrayContaining([
      "subagents.definitions[0].model",
      "cron.model",
      "cron.jobs[0].model",
      "webhook.model",
      "webhook.endpoints[0].model",
    ]));
    expect(result.output).not.toContain("pi:");
    expect(result.output).toContain('"model": "anthropic:claude-opus-5"');
    expect(result.output).toContain('"model": "openai-codex:gpt-5.6-luna"');
    expect(result.output).toContain('"model": "openai:gpt-4.1"');
  });

  it("refuses to guess a removed backend ref outside runtime, and reports it", () => {
    const result = migrateConfigSource(`{
  "runtime": { "model": "openai-codex:gpt-5.6-sol" },
  "subagents": {
    "definitions": [
      { "name": "helper", "description": "d", "prompt": "p", "model": "claude:sonnet" }
    ]
  },
  "cron": {
    "jobs": [
      { "id": "j", "expression": "0 7 * * *", "prompt": "p", "model": "opencode:github-copilot:gpt-4.1" }
    ]
  },
  "webhook": {
    "endpoints": [{ "name": "e", "path": "/e", "model": "codex:gpt-5.6-terra" }]
  }
}
`);

    expect(result.manualMigrations).toEqual([
      { pointer: "subagents.definitions[0].model", value: "claude:sonnet" },
      { pointer: "cron.jobs[0].model", value: "opencode:github-copilot:gpt-4.1" },
      { pointer: "webhook.endpoints[0].model", value: "codex:gpt-5.6-terra" },
    ]);
    expect(result.changed).toBe(false);
    expect(result.output).toContain('"claude:sonnet"');
    expect(result.output).toContain('"codex:gpt-5.6-terra"');
  });

  it("never rewrites model fields that are not runtime references", () => {
    // `tools.web.search.codex.model` is a Codex app-server model id for the
    // SURVIVING Codex web-search backend, not a removed runtime bridge.
    const source = `{
  "runtime": { "model": "openai-codex:gpt-5.6-sol" },
  "tools": { "web": { "search": { "backend": "codex", "codex": { "model": "gpt-5.6-luna" } } } },
  "telegram": { "transcription": { "model": "whisper-1" } },
  "openaiApi": { "modelId": "agent" },
  "memory": { "mode": "lite", "embeddingModel": "nomic-embed-text:v1.5" }
}
`;
    const result = migrateConfigSource(source);
    expect(result.changed).toBe(false);
    expect(result.manualMigrations).toEqual([]);
    expect(result.output).toBe(source);
  });

  it("leaves memory.llm.model alone unless the provider makes it a runtime reference", () => {
    // `readMemoryLlmConfig` parses this field as a mono runtime reference only
    // under `agent-host`. The default `ollama` provider hands the string to the
    // Ollama service, where a colon is a tag separator -- so `pi:qwen3` is a
    // real local model name and stripping the prefix breaks memory silently.
    for (const llm of ['{ "model": "pi:qwen3" }', '{ "provider": "ollama", "model": "pi:qwen3" }']) {
      const source = `{\n  "runtime": { "model": "openai-codex:gpt-5.6-sol" },\n  "memory": { "llm": ${llm} }\n}\n`;
      const result = migrateConfigSource(source);
      expect(result.changed).toBe(false);
      expect(result.manualMigrations).toEqual([]);
      expect(result.output).toBe(source);
    }

    const hosted = migrateConfigSource(
      `{\n  "memory": { "llm": { "provider": "agent-host", "model": "pi:openai:gpt-4.1-mini" } }\n}\n`,
    );
    expect(hosted.changed).toBe(true);
    expect(hosted.output).toContain('"model": "openai:gpt-4.1-mini"');
  });

  it("still deletes retired memory.llm keys under the ollama provider", () => {
    // Only the model REFERENCE is provider-specific; a retired key is retired
    // either way and would make the loader throw at restart.
    const result = migrateConfigSource(
      `{\n  "memory": { "llm": { "model": "pi:qwen3", "executionMode": "sdk" } }\n}\n`,
    );
    expect(result.changed).toBe(true);
    expect(result.output).not.toContain("executionMode");
    expect(result.output).toContain('"model": "pi:qwen3"');
  });

  it("leaves configVersion 1 prototypes byte-identical", () => {
    const source = `{
  "configVersion": 1,
  "runtimes": {
    "pi": { "$use": "managed" }
  }
}
`;
    const result = migrateConfigSource(source);
    expect(result.skipped).toBe(true);
    expect(result.skippedReason).toBe("skipped (configVersion 1 prototype)");
    expect(result.changed).toBe(false);
    expect(result.output).toBe(source);
  });

  it("reports a conflict when fallbackModels coexists with a populated fallbacks array", () => {
    const source = `{
  "runtime": {
    "model": "openai-codex:gpt-5.6-sol",
    "fallbackModels": ["a"],
    "fallbacks": [{ "model": "x" }]
  }
}
`;
    const result = migrateConfigSource(source);
    expect(result.conflict).toBeDefined();
    expect(result.changed).toBe(false);
    expect(result.output).toBe(source);
  });

  it("replaces an empty fallbacks array with the converted fallbackModels", () => {
    const result = migrateConfigSource(`{
  "runtime": {
    "model": "openai-codex:gpt-5.6-sol",
    "fallbackModels": ["a"],
    "fallbacks": []
  }
}
`);
    expect(result.conflict).toBeUndefined();
    expect(result.output).toContain('"model": "a"');
    expect(result.output).not.toContain("fallbackModels");
  });

  it("preserves 4-space indentation and key order", () => {
    const result = migrateConfigSource(`{
    "runtime": {
        "model": "pi:openai-codex:gpt-5.6-sol",
        "executionMode": "sdk"
    },
    "tools": {
        "web": {
            "search": {
                "backend": "auto"
            }
        }
    }
}
`);
    expect(result.output).toContain('    "tools": {');
    expect(result.output).toContain('        "model": "openai-codex:gpt-5.6-sol"');
    expect(result.output.indexOf('"runtime"')).toBeLessThan(result.output.indexOf('"tools"'));
    expect(result.output).not.toContain("executionMode");
  });

  it("applies surgical edits so every unrelated byte stays identical", () => {
    const input = `{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-sol",
    "fallbackModels": [
      "pi:anthropic:claude-opus-5",
      "pi:github-copilot:gemini-3.1-pro-preview"
    ],
    "routeSafety": "uniform",
    "executionMode": "sdk"
  },
  "context": {
    "identityPath": "./IDENTITY.md",
    "selectedSkills": []
  },
  "tags": ["a8c", "triage", "read-only"],
  "meta": {"owner": "robert"},
  "memory": {
    "mode": "bujo",
    "llm": {
      "provider": "agent-host",
      "model": "pi:openai-codex:gpt-5.6-luna",
      "executionMode": "sdk",
      "trace": "won\\u2019t unescape, nor \\u2014 this",
      "note": "raw ’ stays raw —"
    }
  }
}
`;
    const expected = `{
  "runtime": {
    "model": "openai-codex:gpt-5.6-sol",
    "fallbacks": [
      {
        "model": "anthropic:claude-opus-5"
      },
      {
        "model": "github-copilot:gemini-3.1-pro-preview"
      }
    ]
  },
  "context": {
    "identityPath": "./IDENTITY.md",
    "selectedSkills": []
  },
  "tags": ["a8c", "triage", "read-only"],
  "meta": {"owner": "robert"},
  "memory": {
    "mode": "bujo",
    "llm": {
      "provider": "agent-host",
      "model": "openai-codex:gpt-5.6-luna",
      "trace": "won\\u2019t unescape, nor \\u2014 this",
      "note": "raw ’ stays raw —"
    }
  }
}
`;
    const result = migrateConfigSource(input);
    expect(result.changed).toBe(true);
    // The whole-file diff: the only permitted differences are the intended ones.
    expect(result.output).toBe(expected);
    // Escaped non-ASCII is preserved as escapes; raw non-ASCII is preserved raw.
    expect(result.output).toContain('won\\u2019t unescape, nor \\u2014 this');
    expect(result.output).toContain('raw ’ stays raw —');
    expect(result.output).toContain('"tags": ["a8c", "triage", "read-only"]');
    expect(result.output).toContain('"meta": {"owner": "robert"}');
  });

  it("preserves genuinely raw (un-escaped) UTF-8 verbatim", () => {
    const source = `{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-sol",
    "description": "the em dash — and apostrophe ’ stay raw"
  }
}
`;
    const result = migrateConfigSource(source);
    expect(result.output).toContain('the em dash — and apostrophe ’ stay raw');
    expect(result.output).not.toContain("\\u2014");
    expect(result.output).not.toContain("\\u2019");
  });
});

describe("migrateTriggerMarkdown", () => {
  it("rewrites the frontmatter model and leaves every other byte identical", () => {
    const source = "---\nexpression: 0 7 * * *\nmodel: pi:openai:gpt-4.1-mini\neffort: high\n---\n\n# Digest\n\nmodel: pi:not-frontmatter\n";
    const result = migrateTriggerMarkdown(source, "cron/digest.md");
    expect(result.changed).toBe(true);
    expect(result.output).toBe(
      "---\nexpression: 0 7 * * *\nmodel: openai:gpt-4.1-mini\neffort: high\n---\n\n# Digest\n\nmodel: pi:not-frontmatter\n",
    );
    expect(result.changes).toEqual([{
      kind: "rewrite",
      pointer: "cron/digest.md#model",
      before: '"pi:openai:gpt-4.1-mini"',
      after: '"openai:gpt-4.1-mini"',
    }]);
  });

  it("keeps the authored quoting style", () => {
    const result = migrateTriggerMarkdown('---\npath: /t\nmodel: "pi:openai:gpt-4.1"\n---\n\nGo.\n', "webhook/t.md");
    expect(result.output).toBe('---\npath: /t\nmodel: "openai:gpt-4.1"\n---\n\nGo.\n');
  });

  it("refuses to guess a removed backend and reports it for a human", () => {
    const result = migrateTriggerMarkdown("---\nexpression: @daily\nmodel: codex:gpt-5.6-terra\n---\n\nGo.\n", "cron/j.md");
    expect(result.changed).toBe(false);
    expect(result.manualMigrations).toEqual([{ pointer: "cron/j.md#model", value: "codex:gpt-5.6-terra" }]);
  });

  it("edits the last model line, which is the one the loader's flat map keeps", () => {
    const result = migrateTriggerMarkdown(
      "---\nmodel: openai:a\n# model: pi:commented-out\nmodel: pi:openai:b\n---\n\nGo.\n",
      "cron/j.md",
    );
    expect(result.output).toBe("---\nmodel: openai:a\n# model: pi:commented-out\nmodel: openai:b\n---\n\nGo.\n");
  });

  it("ignores a file with no frontmatter, and a frontmatter with no model", () => {
    for (const source of ["Just a prompt with model: pi:x in it.\n", "---\nexpression: @daily\n---\n\nGo.\n"]) {
      const result = migrateTriggerMarkdown(source, "cron/j.md");
      expect(result.changed).toBe(false);
      expect(result.manualMigrations).toEqual([]);
      expect(result.output).toBe(source);
    }
  });

  it("preserves CRLF line endings byte for byte", () => {
    const result = migrateTriggerMarkdown("---\r\nexpression: @daily\r\nmodel: pi:openai:a\r\n---\r\n\r\nGo.\r\n", "cron/j.md");
    expect(result.output).toBe("---\r\nexpression: @daily\r\nmodel: openai:a\r\n---\r\n\r\nGo.\r\n");
  });
});

describe("runCli migrate-config", () => {
  let dir: string;
  let previousCwd: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "agent-app-migrate-config-")));
    previousCwd = process.cwd();
  });

  afterEach(async () => {
    fsHooks.queue.length = 0;
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  });

  async function captureRunCli(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write);

    try {
      const code = await runCli(argv);
      return { code, stdout: stdout.join(""), stderr: stderr.join("") };
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  }

  interface WriteOutcome { readonly code: number; readonly error?: string }

  /**
   * Two `--write` runs guaranteed to be in flight at once: the second is
   * launched from inside the first's config read, so it cannot observe the
   * first's replacement and both compute their migration from the same bytes.
   * Output is silenced ONCE around the pair, because nesting `captureRunCli`'s
   * spies would restore them out of order. A rejection is folded into the
   * outcome so an assertion can name it instead of failing on an unhandled
   * error.
   */
  async function racedWrites(configPath: string): Promise<readonly WriteOutcome[]> {
    const silence = (() => true) as typeof process.stdout.write;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(silence);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(silence);
    const attempt = async (): Promise<WriteOutcome> => {
      try {
        return { code: await runCli(["migrate-config", "--write"]) };
      } catch (error) {
        return { code: -1, error: error instanceof Error ? error.message : String(error) };
      }
    };
    // Freeze the clock so the two runs provably share a millisecond -- the
    // exact precondition the old path/pid/millisecond temp name needed to
    // collide. Nothing in `migrate-config` reads the clock for anything else.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      let second: Promise<WriteOutcome> | undefined;
      let secondHasRead = (): void => {};
      const secondRead = new Promise<void>((resolve) => { secondHasRead = resolve; });
      fsHooks.queue.push(
        // Fired by the first run's read: start the second run and hold the
        // first inside its own read until the second has read the same bytes.
        { path: configPath, run: async () => { second = attempt(); await secondRead; } },
        { path: configPath, run: () => { secondHasRead(); } },
      );
      const first = await attempt();
      return [first, await second!];
    } finally {
      fsHooks.queue.length = 0;
      nowSpy.mockRestore();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  }

  const dirtyConfig = `{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-sol",
    "executionMode": "sdk"
  }
}
`;

  it("is idempotent: a second --write is a no-op that never clobbers the first backup", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, dirtyConfig, "utf8");
    process.chdir(dir);

    const first = await captureRunCli(["migrate-config", "--write"]);
    expect(first.code).toBe(0);

    const migrated = await readFile(configPath, "utf8");
    expect(migrated).not.toContain("executionMode");
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe(dirtyConfig);

    const second = await captureRunCli(["migrate-config", "--write"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("already migrated");
    expect(await readFile(configPath, "utf8")).toBe(migrated);
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe(dirtyConfig);
  });

  it("--check exits 1 when work remains and 0 when clean", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, dirtyConfig, "utf8");
    process.chdir(dir);

    const dirty = await captureRunCli(["migrate-config", "--check"]);
    expect(dirty.code).toBe(1);
    expect(dirty.stdout).toContain("runtime.executionMode");
    expect(dirty.stdout).toContain("runtime.model");

    await writeFile(configPath, `{\n  "runtime": {\n    "model": "openai-codex:gpt-5.6-sol"\n  }\n}\n`, "utf8");
    const clean = await captureRunCli(["migrate-config", "--check"]);
    expect(clean.code).toBe(0);
  });

  it("--write applies safe transforms and still exits non-zero with the unresolved ref listed", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, `{
  "runtime": {
    "model": "codex:gpt-5.6-terra",
    "executionMode": "sdk"
  }
}
`, "utf8");
    process.chdir(dir);

    const result = await captureRunCli(["migrate-config", "--write"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("runtime.model");
    expect(result.stdout).toContain("codex:gpt-5.6-terra");
    expect(result.stdout).toContain("human");

    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain("executionMode");
    expect(after).toContain('"codex:gpt-5.6-terra"');
  });

  it("--check fails on a removed backend ref the loader would reject at restart", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, `{
  "runtime": { "model": "openai-codex:gpt-5.6-sol" },
  "subagents": {
    "definitions": [
      { "name": "helper", "description": "d", "prompt": "p", "model": "codex:gpt-5.6-terra" }
    ]
  }
}
`, "utf8");
    process.chdir(dir);

    const result = await captureRunCli(["migrate-config", "--check"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("subagents.definitions[0].model");
    expect(result.stdout).toContain("codex:gpt-5.6-terra");
  });

  it("--write replaces the config by rename, so no reader ever sees a truncated file", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, dirtyConfig, "utf8");
    await chmod(configPath, 0o600);
    // A second name for the SAME inode. `writeFile` mutates the inode in
    // place, so it would truncate and rewrite this witness too; a rename
    // swaps in a new inode and leaves the witness on the original bytes.
    // Checking only the final content and the absence of debris (as this test
    // once did) passes with the atomic writer removed entirely.
    const witness = join(dir, "witness.json");
    await link(configPath, witness);
    const before = await stat(configPath);
    process.chdir(dir);

    const result = await captureRunCli(["migrate-config", "--write"]);
    expect(result.code).toBe(0);

    const after = await stat(configPath);
    expect(after.ino).not.toBe(before.ino);
    expect(await readFile(witness, "utf8")).toBe(dirtyConfig);
    expect(await readFile(configPath, "utf8")).not.toContain("executionMode");
    expect(after.mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual([
      "mono-agent.config.json",
      "mono-agent.config.json.bak",
      "witness.json",
    ]);
  });

  it.each([0o600, 0o640])("gives the backup the config's own mode (%i), not the umask default", async (mode) => {
    // `writeFileAtomic` used to stat the BACKUP pathname, which does not exist
    // on a first run, so the `.bak` — a byte-exact copy of a private config —
    // was created with whatever the umask allowed.
    const home = join(dir, `mode-${mode.toString(8)}`);
    await mkdir(home);
    const configPath = join(home, "mono-agent.config.json");
    await writeFile(configPath, dirtyConfig, "utf8");
    await chmod(configPath, mode);
    process.chdir(home);

    const result = await captureRunCli(["migrate-config", "--write"]);
    expect(result.code).toBe(0);
    expect((await stat(configPath)).mode & 0o777).toBe(mode);
    expect((await stat(`${configPath}.bak`)).mode & 0o777).toBe(mode);
  });

  it("writes THROUGH a symlinked config instead of replacing the link", async () => {
    // Renaming over the link's own dirent turns a shared config into a private
    // regular file and leaves the shared original unmigrated. The `writeFile`
    // this replaced followed the link, and so must the atomic replacement.
    const shared = join(dir, "shared.config.json");
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(shared, dirtyConfig, "utf8");
    await symlink(shared, configPath);
    process.chdir(dir);

    const result = await captureRunCli(["migrate-config", "--write"]);
    expect(result.code).toBe(0);
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(shared, "utf8")).not.toContain("executionMode");
    expect(await readFile(configPath, "utf8")).not.toContain("executionMode");
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe(dirtyConfig);
  });

  it("refuses to overwrite a config another writer changed after it was read", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, dirtyConfig, "utf8");
    process.chdir(dir);

    const concurrent = `{
  "runtime": {
    "model": "openai-codex:gpt-5.6-sol",
    "note": "written by someone else"
  }
}
`;
    fsHooks.queue.push({ path: configPath, run: () => writeFileSync(configPath, concurrent, "utf8") });

    const result = await captureRunCli(["migrate-config", "--write"]);
    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("changed on disk");
    // The other writer's bytes survive, and nothing was backed up over.
    expect(await readFile(configPath, "utf8")).toBe(concurrent);
    expect(await readdir(dir)).toEqual(["mono-agent.config.json"]);
  });

  it("lets concurrent --write runs share a directory without destroying each other's staged file", async () => {
    // The temp name used to be path + pid + millisecond, so two callers in the
    // same tick picked the SAME name; the loser of `open(...,"wx")` then
    // deleted the winner's staged file and BOTH runs failed -- with the config
    // left unmigrated. At least one run must succeed and the config must end up
    // migrated. (Both succeeding is legitimate: they computed identical output
    // from identical bytes, so the second rename is a no-op replacement.)
    for (let pair = 0; pair < 3; pair += 1) {
      const home = join(dir, `pair-${pair}`);
      await mkdir(home);
      const configPath = join(home, "mono-agent.config.json");
      await writeFile(configPath, dirtyConfig, "utf8");
      process.chdir(home);

      const outcomes = await racedWrites(configPath);
      expect(outcomes.filter((outcome) => outcome.error !== undefined)).toEqual([]);
      expect(outcomes.map((outcome) => outcome.code)).toContain(0);
      expect(await readFile(configPath, "utf8")).not.toContain("executionMode");
      expect(await readFile(`${configPath}.bak`, "utf8")).toBe(dirtyConfig);
      expect((await readdir(home)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    }
  });

  it("migrates cron and webhook markdown overrides the JSON document never mentions", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, `{\n  "runtime": { "model": "openai-codex:gpt-5.6-sol" }\n}\n`, "utf8");
    await mkdir(join(dir, "cron"));
    const jobPath = join(dir, "cron", "digest.md");
    const job = "---\nexpression: 0 7 * * *\nmodel: pi:openai:gpt-4.1-mini\neffort: high\n---\n\nSummarise the day.\n";
    await writeFile(jobPath, job, "utf8");
    await mkdir(join(dir, "webhook"));
    const endpointPath = join(dir, "webhook", "triage.md");
    await writeFile(endpointPath, "---\npath: /t\nmodel: acp:claude\n---\n\nTriage it.\n", "utf8");
    process.chdir(dir);

    // The JSON alone is clean, so a config-only codemod exited 0 here while the
    // adapters still loaded both overrides straight off these files.
    const checked = await captureRunCli(["migrate-config", "--check", "--json"]);
    expect(checked.code).toBe(1);
    const payload = JSON.parse(checked.stdout) as {
      readonly changed: boolean;
      readonly changes: readonly { readonly pointer: string }[];
      readonly manualMigrations: readonly { readonly pointer: string; readonly value: string }[];
    };
    expect(payload.changed).toBe(true);
    expect(payload.changes.map((change) => change.pointer)).toEqual(["cron/digest.md#model"]);
    expect(payload.manualMigrations).toEqual([{ pointer: "webhook/triage.md#model", value: "acp:claude" }]);

    const written = await captureRunCli(["migrate-config", "--write"]);
    expect(written.code).toBe(1); // the acp: ref still needs a human
    expect(await readFile(jobPath, "utf8")).toBe(
      "---\nexpression: 0 7 * * *\nmodel: openai:gpt-4.1-mini\neffort: high\n---\n\nSummarise the day.\n",
    );
    expect(await readFile(`${jobPath}.bak`, "utf8")).toBe(job);
    // Refused, not guessed: the endpoint file is untouched and unbacked-up.
    expect(await readFile(endpointPath, "utf8")).toContain("model: acp:claude");
    expect((await readdir(join(dir, "webhook"))).sort()).toEqual(["triage.md"]);
  });

  it("honours a renamed cron.dir when hunting trigger markdown", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, `{\n  "cron": { "dir": "schedules" }\n}\n`, "utf8");
    await mkdir(join(dir, "schedules"));
    await writeFile(
      join(dir, "schedules", "nightly.md"),
      "---\nexpression: 0 3 * * *\nmodel: pi:anthropic:claude-opus-5\n---\n\nRun.\n",
      "utf8",
    );
    process.chdir(dir);

    const result = await captureRunCli(["migrate-config", "--check"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("schedules/nightly.md#model");
  });

  it("skips configVersion 1 prototypes and leaves them byte-identical", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    const prototype = `{\n  "configVersion": 1,\n  "runtimes": { "pi": { "$use": "managed" } }\n}\n`;
    await writeFile(configPath, prototype, "utf8");
    process.chdir(dir);

    const result = await captureRunCli(["migrate-config", "--check"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("skipped (configVersion 1 prototype)");
    expect(await readFile(configPath, "utf8")).toBe(prototype);
  });

  it("refuses to write when fallbacks is already populated", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    const conflicted = `{
  "runtime": {
    "model": "openai-codex:gpt-5.6-sol",
    "fallbackModels": ["a"],
    "fallbacks": [{ "model": "x" }]
  }
}
`;
    await writeFile(configPath, conflicted, "utf8");
    process.chdir(dir);

    const result = await captureRunCli(["migrate-config", "--write"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("runtime.fallbacks");
    expect(await readFile(configPath, "utf8")).toBe(conflicted);
  });

  it("--write preserves every byte it was not asked to change", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    const input = `{
  "runtime": {
    "model": "pi:openai-codex:gpt-5.6-sol",
    "executionMode": "sdk"
  },
  "meta": {"owner": "robert"},
  "tags": ["a8c", "read-only"],
  "memory": { "llm": { "provider": "agent-host", "model": "pi:openai-codex:gpt-5.6-luna", "executionMode": "sdk" } },
  "desc": "won\\u2019t unescape —"
}
`;
    const expected = `{
  "runtime": {
    "model": "openai-codex:gpt-5.6-sol"
  },
  "meta": {"owner": "robert"},
  "tags": ["a8c", "read-only"],
  "memory": { "llm": { "provider": "agent-host", "model": "openai-codex:gpt-5.6-luna" } },
  "desc": "won\\u2019t unescape —"
}
`;
    await writeFile(configPath, input, "utf8");
    process.chdir(dir);

    const result = await captureRunCli(["migrate-config", "--write"]);
    expect(result.code).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe(expected);
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe(input);
  });

  it("refuses a document that declares the same key twice", () => {
    // JSON.parse keeps the LAST occurrence while the scanner addresses the
    // FIRST, so an edit would rewrite dead text and leave the effective value
    // alone: --write would claim success and --check would never converge.
    const result = migrateConfigSource(
      '{"runtime":{"model":"openai:gpt-5.4"},"runtime":{"model":"pi:openai:gpt-5.4","executionMode":"sdk"}}',
    );
    expect(result.conflict).toContain('"runtime" more than once');
    expect(result.changed).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it("exempts only the literal configVersion 1 prototype", () => {
    const v1 = migrateConfigSource('{"configVersion":1,"runtimes":{"pi":{}}}');
    expect(v1.skipped).toBe(true);

    // A v2 file carrying retired keys must be migrated, not waved through.
    const v2 = migrateConfigSource(
      '{"configVersion":2,"runtime":{"model":"pi:openai-codex:gpt-5.6-sol","executionMode":"sdk"}}',
    );
    expect(v2.skipped).toBe(false);
    expect(v2.changed).toBe(true);
  });

  it("separates the removed nested OpenCode backend ref from the Pi provider id", () => {
    // `opencode:<provider>:<model>` was the deleted direct backend and needs a
    // human; `opencode-go:<model>` and plain `opencode:<model>` are Pi routes.
    const nested = migrateConfigSource('{"runtime":{"model":"opencode:github-copilot:gpt-4.1"}}');
    expect(nested.manualMigrations).toHaveLength(1);

    const piRoute = migrateConfigSource('{"runtime":{"model":"opencode-go:deepseek-v4-pro"}}');
    expect(piRoute.manualMigrations).toEqual([]);
    expect(piRoute.changed).toBe(false);
  });
});
