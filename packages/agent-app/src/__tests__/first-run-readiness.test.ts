import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ValidationReport } from "../doctor.js";
import {
  effectiveFirstRunEnvironment,
  evaluateFirstRunReadiness,
  hasSensitivePersistedEnvironmentValue,
  piAuthPathBackgroundConflict,
  readCliConfigSnapshot,
  readCliDotenvFile,
  readCliDotenvSnapshot,
  resolveEffectivePiAuthPath,
  selectedSecretEnvironmentConflicts,
  selectedSecretValues,
  unexpectedPersistedMonoAgentOverrides,
  validateWizardPlanInStaging,
  withExactProcessEnvironment,
} from "../first-run-readiness.js";
import { composeWizardPlan, defaultAnswers } from "../wizard/answers.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function telegramPlan() {
  return composeWizardPlan(defaultAnswers({
    channels: ["channel:telegram"],
    moduleInputs: { "channel:telegram": { allowedUserIds: "123" } },
  }), { dirBasename: "test-agent", skillsRootExists: false });
}

function report(
  statuses: Readonly<Record<string, "ok" | "waiting" | "disabled" | "error">>,
): ValidationReport {
  const sections = Object.entries(statuses).map(([id, status]) => ({
    id,
    label: id,
    status,
    details: [],
  }));
  return { sections, ok: sections.every((section) => section.status !== "error") };
}

describe("first-run environment", () => {
  it("loads durable values without replacing operational state, then overlays entered values", () => {
    const result = effectiveFirstRunEnvironment({
      shellEnv: {
        PATH: "/shell/bin",
        HOME: "/shell/home",
        OPENAI_API_KEY: "shell-openai",
        ANTHROPIC_API_KEY: "shell-anthropic",
        CODEX_HOME: "/tmp/shell-only-codex",
        CLAUDE_CONFIG_DIR: "/tmp/shell-only-claude",
        MONO_AGENT_ALLOWED_TOOLS: "shell,tools",
        MONO_AGENT_MODEL: "pi:shell:model",
        MONO_AGENT_OPENAI_API_KEY: "shell-mono-openai",
      },
      dotenvEnv: {
        PATH: "/dotenv/bin",
        HOME: "/dotenv/home",
        OPENAI_API_KEY: "persisted-openai",
        CODEX_HOME: "/Users/example/.codex",
        CLAUDE_CONFIG_DIR: "/Users/example/.claude",
        DOTENV_ONLY: "yes",
        MONO_AGENT_TELEGRAM_BOT_TOKEN: "old",
      },
      enteredSecrets: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "new" },
      resolvedPiAuthPath: "/auth/pi.json",
    });
    expect(result).toMatchObject({
      PATH: "/shell/bin",
      HOME: "/shell/home",
      OPENAI_API_KEY: "persisted-openai",
      CODEX_HOME: "/Users/example/.codex",
      CLAUDE_CONFIG_DIR: "/Users/example/.claude",
      DOTENV_ONLY: "yes",
      MONO_AGENT_TELEGRAM_BOT_TOKEN: "new",
      MONO_AGENT_PI_AUTH_PATH: "/auth/pi.json",
    });
    expect(result).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(result).not.toHaveProperty("MONO_AGENT_ALLOWED_TOOLS");
    expect(result).not.toHaveProperty("MONO_AGENT_MODEL");
    expect(result).not.toHaveProperty("MONO_AGENT_OPENAI_API_KEY");
  });

  it("reports persisted wizard-plan overrides by exact name while allowing secrets and Pi auth", () => {
    const plan = telegramPlan();
    expect(unexpectedPersistedMonoAgentOverrides(plan, {
      MONO_AGENT_ALLOWED_TOOLS: "bash",
      MONO_AGENT_MAX_TURNS: "9",
      MONO_AGENT_PI_AUTH_PATH: "./auth.json",
      MONO_AGENT_TELEGRAM_BOT_TOKEN: "telegram-secret",
      MONO_AGENT_OPENAI_API_KEY: "openai-secret",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV: "CUSTOM_KEY",
    })).toEqual([
      "MONO_AGENT_ALLOWED_TOOLS",
      "MONO_AGENT_MAX_TURNS",
      "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV",
    ]);
  });

  it("detects only selected secret conflicts and exposes selected probe values", () => {
    const plan = telegramPlan();
    expect(selectedSecretEnvironmentConflicts(
      plan,
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "shell", UNRELATED: "shell" },
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "dotenv", UNRELATED: "dotenv" },
    )).toEqual(["MONO_AGENT_TELEGRAM_BOT_TOKEN"]);
    expect(selectedSecretEnvironmentConflicts(
      plan,
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "shell-only" },
      {},
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "newly-entered" },
    )).toEqual(["MONO_AGENT_TELEGRAM_BOT_TOKEN"]);
    expect(selectedSecretEnvironmentConflicts(
      plan,
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "same" },
      {},
      { MONO_AGENT_TELEGRAM_BOT_TOKEN: "same" },
    )).toEqual([]);
    expect(selectedSecretValues(plan, {
      MONO_AGENT_TELEGRAM_BOT_TOKEN: "persisted",
      OTHER_TOKEN: "not selected",
    })).toEqual({ MONO_AGENT_TELEGRAM_BOT_TOKEN: "persisted" });
  });

  it("recognizes durable provider credentials that require secure dotenv handling", () => {
    expect(hasSensitivePersistedEnvironmentValue({ OPENAI_API_KEY: "provider-key" })).toBe(true);
    expect(hasSensitivePersistedEnvironmentValue({ ANTHROPIC_AUTH_TOKEN: "provider-token" })).toBe(true);
    expect(hasSensitivePersistedEnvironmentValue({ GOOGLE_APPLICATION_CREDENTIALS: "/private/key.json" })).toBe(true);
    expect(hasSensitivePersistedEnvironmentValue({ OPENAI_API_KEY: "", OLLAMA_HOST: "localhost:11434" })).toBe(false);
  });

  it("parses dotenv separately without mutating process.env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "first-run-env-"));
    temporaryDirectories.push(dir);
    const path = join(dir, ".env");
    const before = process.env.FIRST_RUN_TEST_TOKEN;
    await writeFile(path, "FIRST_RUN_TEST_TOKEN='from file'\n");
    expect(await readCliDotenvFile(path)).toEqual({ FIRST_RUN_TEST_TOKEN: "from file" });
    expect(process.env.FIRST_RUN_TEST_TOKEN).toBe(before);
    await expect(readCliDotenvFile(join(dir, "missing"))).resolves.toEqual({});
  });

  it("fingerprints an open regular dotenv handle and refuses symlink or directory inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "first-run-safe-env-"));
    temporaryDirectories.push(dir);
    const target = join(dir, "target.env");
    const link = join(dir, "linked.env");
    const directory = join(dir, "directory.env");
    await writeFile(target, "TOKEN=secret\n", { mode: 0o600 });
    await symlink(target, link);
    await mkdir(directory);

    const snapshot = await readCliDotenvSnapshot(target);
    expect(snapshot.env).toEqual({ TOKEN: "secret" });
    expect(snapshot.fingerprint).not.toContain("secret");
    await expect(readCliDotenvSnapshot(link)).rejects.toThrow(/symbolic link/u);
    await expect(readCliDotenvSnapshot(directory)).rejects.toThrow(/not a regular file/u);
  });

  it("binds config snapshots to exact regular-file contents and identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "first-run-safe-config-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "mono-agent.config.json");
    const link = join(dir, "linked.config.json");
    await writeFile(path, "{\"runtime\":{}}\n", { mode: 0o600 });
    await symlink(path, link);

    const before = await readCliConfigSnapshot(path);
    expect(before.contents).toBe("{\"runtime\":{}}\n");
    expect(before.fingerprint).not.toContain(before.contents);
    await writeFile(path, "{\"runtime\":{\"maxTurns\":2}}\n", { mode: 0o600 });
    const after = await readCliConfigSnapshot(path);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    await expect(readCliConfigSnapshot(link)).rejects.toThrow(/symbolic link/u);
  });

  it("rejects FIFO and device dotenv inputs without blocking before the regular-file check", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "first-run-special-env-"));
    temporaryDirectories.push(dir);
    const fifo = join(dir, "fifo.env");
    await execFileAsync("mkfifo", [fifo]);

    const pending = readCliDotenvSnapshot(fifo);
    let blockTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ readonly kind: "blocked" }>((resolveBlocked) => {
        blockTimer = setTimeout(() => resolveBlocked({ kind: "blocked" }), 500);
      }),
    ]);
    if (blockTimer !== undefined) clearTimeout(blockTimer);
    if (outcome.kind === "blocked") {
      // Keep a regression from hanging the test worker forever: a writer lets
      // a blocking read-only open proceed to its fstat rejection.
      await Promise.allSettled([
        execFileAsync("sh", ["-c", "printf x > \"$1\"", "sh", fifo]),
        pending,
      ]);
    }

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toMatch(/not a regular file/u);
    }
    await expect(readCliDotenvSnapshot("/dev/null")).rejects.toThrow(/not a regular file/u);
  });

  it("serializes exact durable process environments and restores the caller snapshot", async () => {
    const shellOnlyName = "MONO_AGENT_TEST_SHELL_ONLY_SECRET";
    const durableName = "MONO_AGENT_TEST_DURABLE_SECRET";
    const previousShellOnly = process.env[shellOnlyName];
    const previousDurable = process.env[durableName];
    process.env[shellOnlyName] = "shell-only";
    delete process.env[durableName];
    const durableEnv: Record<string, string | undefined> = { ...process.env, [durableName]: "durable" };
    delete durableEnv[shellOnlyName];

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolveStarted) => {
      markFirstStarted = resolveStarted;
    });
    const holdFirst = new Promise<void>((resolveHold) => {
      releaseFirst = resolveHold;
    });
    let secondStarted = false;

    try {
      const first = withExactProcessEnvironment(durableEnv, async () => {
        expect(process.env[shellOnlyName]).toBeUndefined();
        expect(process.env[durableName]).toBe("durable");
        markFirstStarted();
        await holdFirst;
      });
      await firstStarted;
      const second = withExactProcessEnvironment({ ...durableEnv, [durableName]: "second" }, async () => {
        secondStarted = true;
        expect(process.env[shellOnlyName]).toBeUndefined();
        expect(process.env[durableName]).toBe("second");
      });
      await Promise.resolve();
      expect(secondStarted).toBe(false);
      releaseFirst();
      await Promise.all([first, second]);

      expect(process.env[shellOnlyName]).toBe("shell-only");
      expect(process.env[durableName]).toBeUndefined();
      await expect(withExactProcessEnvironment(durableEnv, async () => {
        throw new Error("exact-env-test");
      })).rejects.toThrow("exact-env-test");
      expect(process.env[shellOnlyName]).toBe("shell-only");
    } finally {
      if (previousShellOnly === undefined) delete process.env[shellOnlyName];
      else process.env[shellOnlyName] = previousShellOnly;
      if (previousDurable === undefined) delete process.env[durableName];
      else process.env[durableName] = previousDurable;
    }
  });
});

describe("Pi auth path", () => {
  it("uses explicit, env, config, default precedence and expands paths", () => {
    const cwd = "/tmp/agent";
    expect(resolveEffectivePiAuthPath({
      cwd,
      explicitPath: "explicit/auth.json",
      envPath: "env/auth.json",
      configPath: "config/auth.json",
    })).toBe(resolve(cwd, "explicit/auth.json"));
    expect(resolveEffectivePiAuthPath({ cwd, envPath: "~/pi/auth.json", configPath: "config/auth.json" }))
      .toBe(resolve(homedir(), "pi/auth.json"));
    expect(resolveEffectivePiAuthPath({ cwd, configPath: "config/auth.json" }))
      .toBe(resolve(cwd, "config/auth.json"));
    expect(resolveEffectivePiAuthPath({ cwd })).toBe(resolve(homedir(), ".pi/agent/auth.json"));
  });

  it("detects shell paths that a background worker cannot reproduce", () => {
    expect(piAuthPathBackgroundConflict({
      cwd: "/tmp/agent",
      shellPath: "shell/auth.json",
      dotenvPath: "dotenv/auth.json",
    })).toBe(true);
    expect(piAuthPathBackgroundConflict({
      cwd: "/tmp/agent",
      shellPath: "shared/auth.json",
      dotenvPath: "shared/auth.json",
    })).toBe(false);
    expect(piAuthPathBackgroundConflict({
      cwd: "/tmp/agent",
      dotenvPath: "dotenv/auth.json",
    })).toBe(false);
  });
});

describe("complete readiness gate", () => {
  it("requires every selected expectation and secure persistence", () => {
    const plan = telegramPlan();
    const readyReport = report({ runtime: "ok", credentials: "ok", "channel:telegram": "ok" });
    expect(evaluateFirstRunReadiness({
      plan,
      report: readyReport,
      secretPersistence: { status: "persisted", changed: true },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    })).toEqual({ ready: true, reasons: [] });

    const waiting = evaluateFirstRunReadiness({
      plan,
      report: report({ runtime: "ok", credentials: "ok", "channel:telegram": "waiting" }),
      secretPersistence: { status: "persisted", changed: true },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    });
    expect(waiting.ready).toBe(false);
    expect(waiting.reasons.join(" ")).toContain("channel:telegram must be ok, but is waiting");

    const refused = evaluateFirstRunReadiness({
      plan,
      report: readyReport,
      secretPersistence: {
        status: "refused",
        changed: false,
        reason: "owner-only-permissions-unsupported",
        detail: "Use the owner-only manual setup path /safe/recovery before retrying.",
      },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
    });
    expect(refused.ready).toBe(false);
    expect(refused.reasons.join(" ")).toContain("owner-only-permissions-unsupported");
    expect(refused.reasons.join(" ")).toContain("/safe/recovery");
  });

  it("requires a successful live check for every persistent primary and fallback route", () => {
    const base = telegramPlan();
    const configJson = structuredClone(base.configJson) as Record<string, unknown>;
    configJson.runtime = {
      ...(configJson.runtime as Record<string, unknown>),
      fallbacks: [
        { model: "claude:claude-sonnet-5", effort: "low" },
        { model: "pi:openai:gpt-5.5" },
      ],
    };
    const plan = { ...base, configJson: configJson as never };
    const reportReady = report({ runtime: "ok", credentials: "ok", "channel:telegram": "ok" });
    const incomplete = evaluateFirstRunReadiness({
      plan,
      report: reportReady,
      secretPersistence: { status: "persisted", changed: true },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra", "claude:claude-sonnet-5"],
    });
    expect(incomplete.ready).toBe(false);
    expect(incomplete.reasons).toContain("Runtime route pi:openai:gpt-5.5 has not completed its exact live readiness check.");

    expect(evaluateFirstRunReadiness({
      plan,
      report: reportReady,
      secretPersistence: { status: "persisted", changed: true },
      verifiedCredentialModelRefs: [
        "codex:gpt-5.6-terra",
        "claude:claude-sonnet-5",
        "pi:openai:gpt-5.5",
      ],
    })).toEqual({ ready: true, reasons: [] });
  });

  it("stages the complete plan, passes exact readiness options, and cleans up", async () => {
    const plan = telegramPlan();
    let stagedCwd = "";
    const result = await validateWizardPlanInStaging({
      plan,
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "secret" },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async (options) => {
        stagedCwd = options.cwd;
        await access(options.configPath);
        await access(join(options.cwd, "IDENTITY.md"));
        expect(options.allowFilesystemWrites).toBe(true);
        expect(options.liveness).toBe(true);
        expect(options.verifiedCredentialModelRefs).toEqual(["codex:gpt-5.6-terra"]);
        return report({ runtime: "ok", "channel:telegram": "ok" });
      },
    });
    expect(result.ok).toBe(true);
    await expect(access(stagedCwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes an existing target skills root and copies only explicitly selected skills", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-skills-source-"));
    temporaryDirectories.push(sourceCwd);
    await mkdir(join(sourceCwd, "skills", "research"), { recursive: true });
    await writeFile(join(sourceCwd, "skills", "research", "SKILL.md"), "# Research\n");
    const plan = composeWizardPlan(defaultAnswers(), {
      dirBasename: "test-agent",
      skillsRootExists: true,
    });
    let stagedCwd = "";

    const result = await validateWizardPlanInStaging({
      plan,
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async (options) => {
        stagedCwd = options.cwd;
        await access(join(options.cwd, "skills"));
        await expect(access(join(options.cwd, "skills", "research", "SKILL.md")))
          .rejects.toMatchObject({ code: "ENOENT" });
        return report({ runtime: "ok", context: "ok" });
      },
    });

    expect(result.ok).toBe(true);
    await expect(access(stagedCwd)).rejects.toMatchObject({ code: "ENOENT" });

    const selectedPlan = {
      ...plan,
      configJson: {
        ...plan.configJson,
        context: { ...plan.configJson.context, selectedSkills: ["research"] },
      },
    };
    await expect(validateWizardPlanInStaging({
      plan: selectedPlan,
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async (options) => {
        await access(join(options.cwd, "skills", "research", "SKILL.md"));
        return report({ runtime: "ok", context: "ok" });
      },
    })).resolves.toMatchObject({ ok: true });
  });

  it("rejects a selected symbolic-link manifest before generated files can follow it outside staging", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-symlink-skill-source-"));
    temporaryDirectories.push(sourceCwd);
    const victim = join(sourceCwd, "outside-victim.md");
    await writeFile(victim, "ORIGINAL-OUTSIDE-STAGING\n");
    await mkdir(join(sourceCwd, "skills", "escape"), { recursive: true });
    await symlink(victim, join(sourceCwd, "skills", "escape", "SKILL.md"));
    const base = composeWizardPlan(defaultAnswers(), {
      dirBasename: "test-agent",
      skillsRootExists: true,
    });
    const plan = {
      ...base,
      configJson: {
        ...base.configJson,
        context: { ...base.configJson.context, selectedSkills: ["escape"] },
      },
      files: [
        ...base.files,
        { path: "skills/escape/SKILL.md", contents: "OVERWRITTEN-BY-GENERATED-FILE\n" },
      ],
    };
    let validateCalled = false;

    await expect(validateWizardPlanInStaging({
      plan,
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async () => {
        validateCalled = true;
        return report({ runtime: "ok", context: "ok" });
      },
    })).rejects.toThrow(/symbolic-link skill manifest/u);

    expect(validateCalled).toBe(false);
    expect(await readFile(victim, "utf8")).toBe("ORIGINAL-OUTSIDE-STAGING\n");
  });

  it("rejects an intermediate selected-skill symlink that leaves the configured root", async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), "first-run-parent-symlink-skill-source-"));
    temporaryDirectories.push(sourceCwd);
    await mkdir(join(sourceCwd, "skills"), { recursive: true });
    await mkdir(join(sourceCwd, "outside"), { recursive: true });
    await writeFile(join(sourceCwd, "outside", "SKILL.md"), "OUTSIDE-SKILL\n");
    await symlink(join("..", "outside"), join(sourceCwd, "skills", "escape"));
    const base = composeWizardPlan(defaultAnswers(), {
      dirBasename: "test-agent",
      skillsRootExists: true,
    });
    const plan = {
      ...base,
      configJson: {
        ...base.configJson,
        context: { ...base.configJson.context, selectedSkills: ["escape"] },
      },
    };

    await expect(validateWizardPlanInStaging({
      plan,
      sourceCwd,
      env: {},
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async () => report({ runtime: "ok", context: "ok" }),
    })).rejects.toThrow(/outside its configured root/u);
  });

  it("refuses generated staging files that escape the disposable agent folder", async () => {
    const base = telegramPlan();
    const plan = {
      ...base,
      files: [{ path: "../escape.txt", contents: "escape" }],
    };

    await expect(validateWizardPlanInStaging({
      plan,
      env: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "secret" },
      verifiedCredentialModelRefs: ["codex:gpt-5.6-terra"],
      validate: async () => report({ runtime: "ok" }),
    })).rejects.toThrow(/outside the disposable agent folder/u);
  });
});
