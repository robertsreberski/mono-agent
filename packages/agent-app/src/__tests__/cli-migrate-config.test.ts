import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateConfigSource } from "../cli-migrate-config-command.js";
import { runCli } from "../cli.js";

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
    "llm": { "model": "pi:openai:gpt-4.1-mini" }
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
    "llm": { "model": "pi:openai:gpt-4.1-mini", "executionMode": "sdk" }
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

describe("runCli migrate-config", () => {
  let dir: string;
  let previousCwd: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "agent-app-migrate-config-")));
    previousCwd = process.cwd();
  });

  afterEach(async () => {
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
  "memory": { "llm": { "model": "pi:openai-codex:gpt-5.6-luna", "executionMode": "sdk" } },
  "desc": "won\\u2019t unescape —"
}
`;
    const expected = `{
  "runtime": {
    "model": "openai-codex:gpt-5.6-sol"
  },
  "meta": {"owner": "robert"},
  "tags": ["a8c", "read-only"],
  "memory": { "llm": { "model": "openai-codex:gpt-5.6-luna" } },
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
