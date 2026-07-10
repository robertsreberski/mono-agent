import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beforeCommit: undefined as (() => Promise<void>) | undefined,
  confirmAnswers: [] as unknown[],
  executeProviderSetupPlan: vi.fn(),
  passwordAnswers: [] as unknown[],
  runInitWizard: vi.fn(),
  runModelRepairWizard: vi.fn(),
  runReadinessProbe: vi.fn(),
  selectAnswers: [] as unknown[],
  validateMonoAgentFolder: vi.fn(),
}));

function nextAnswer(queue: unknown[], name: string): unknown {
  if (queue.length === 0) throw new Error(`No queued ${name} answer.`);
  return queue.shift();
}

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  confirm: vi.fn(async () => nextAnswer(mocks.confirmAnswers, "confirm")),
  intro: vi.fn(),
  isCancel: () => false,
  log: {
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
    warn: vi.fn(),
  },
  note: vi.fn(),
  password: vi.fn(async () => nextAnswer(mocks.passwordAnswers, "password")),
  select: vi.fn(async () => nextAnswer(mocks.selectAnswers, "select")),
  spinner: vi.fn(() => ({
    cancel: vi.fn(),
    error: vi.fn(),
    get isCancelled() {
      return false;
    },
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../wizard/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wizard/run.js")>();
  return {
    ...actual,
    runInitWizard: mocks.runInitWizard,
    runModelRepairWizard: mocks.runModelRepairWizard,
  };
});

vi.mock("../readiness-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../readiness-probe.js")>();
  return { ...actual, runReadinessProbe: mocks.runReadinessProbe };
});

vi.mock("../provider-setup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../provider-setup.js")>();
  return { ...actual, executeProviderSetupPlan: mocks.executeProviderSetupPlan };
});

vi.mock("../doctor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../doctor.js")>();
  return { ...actual, validateMonoAgentFolder: mocks.validateMonoAgentFolder };
});

vi.mock("../init.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../init.js")>();
  return {
    ...actual,
    initMonoAgentFolder: async (options: Parameters<typeof actual.initMonoAgentFolder>[0]) => {
      if (options?.dryRun !== true) await mocks.beforeCommit?.();
      return await actual.initMonoAgentFolder(options);
    },
  };
});

import { runCli } from "../cli.js";
import { defaultAnswers } from "../wizard/answers.js";

const originalCwd = process.cwd();
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalTelegramToken = process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN;
const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const temporaryDirectories: string[] = [];

function readyReport() {
  return {
    ok: true,
    sections: [
      { id: "runtime", label: "Runtime", status: "ok" as const, details: [] },
      { id: "credentials", label: "Credentials", status: "ok" as const, details: [] },
      { id: "context", label: "Context", status: "ok" as const, details: [] },
      { id: "tools", label: "Tools", status: "ok" as const, details: [] },
      { id: "channel:telegram", label: "Telegram", status: "ok" as const, details: [] },
      { id: "channel:webhook", label: "Webhook", status: "ok" as const, details: [] },
    ],
  };
}

beforeEach(async () => {
  delete process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN;
  delete process.env.OPENAI_API_KEY;
  mocks.confirmAnswers.length = 0;
  mocks.passwordAnswers.length = 0;
  mocks.selectAnswers.length = 0;
  mocks.beforeCommit = undefined;
  mocks.executeProviderSetupPlan.mockReset();
  mocks.runInitWizard.mockReset();
  mocks.runModelRepairWizard.mockReset();
  mocks.runReadinessProbe.mockReset();
  mocks.validateMonoAgentFolder.mockReset();
  mocks.runReadinessProbe.mockResolvedValue({ ok: true });
  mocks.validateMonoAgentFolder.mockResolvedValue(readyReport());
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-cli-first-run-"));
  temporaryDirectories.push(dir);
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  if (stdinTtyDescriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdin, "isTTY", stdinTtyDescriptor);
  if (stdoutTtyDescriptor === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdout, "isTTY", stdoutTtyDescriptor);
  if (originalTelegramToken === undefined) delete process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN;
  else process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN = originalTelegramToken;
  if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("guided init state transitions", () => {
  it("securely re-processes an existing selected dotenv secret without replacing its value", async () => {
    const envPath = join(process.cwd(), ".env");
    await writeFile(envPath, "MONO_AGENT_TELEGRAM_BOT_TOKEN=operator-value\n", { mode: 0o644 });
    // Ensure umask did not already make the test fixture owner-only.
    await chmod(envPath, 0o644);
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({
        channels: ["channel:telegram"],
        moduleInputs: { "channel:telegram": { allowedUserIds: "123" } },
      }),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(await readFile(envPath, "utf8")).toBe("MONO_AGENT_TELEGRAM_BOT_TOKEN=operator-value\n");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(mocks.runReadinessProbe).toHaveBeenCalledOnce();
  });

  it("hardens an existing provider key even when the selected plan has no module secrets", async () => {
    const envPath = join(process.cwd(), ".env");
    await writeFile(envPath, "OPENAI_API_KEY=operator-provider-key\n", { mode: 0o644 });
    await chmod(envPath, 0o644);
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(await readFile(envPath, "utf8")).toBe("OPENAI_API_KEY=operator-provider-key\n");
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(process.cwd(), ".gitignore"), "utf8")).toContain("/.env");
  });

  it("refuses readiness when a provider key comes from a tracked dotenv", async () => {
    const envPath = join(process.cwd(), ".env");
    await execFilePromise("git", ["init", "-q"], process.cwd());
    await writeFile(envPath, "OPENAI_API_KEY=tracked-provider-key\n", { mode: 0o600 });
    await execFilePromise("git", ["add", "-f", ".env"], process.cwd());
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.selectAnswers.push("cancel");

    await expect(runCli(["init"])).resolves.toBe(1);

    await expect(access(join(process.cwd(), "mono-agent.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.confirmAnswers).toEqual([]);
  });

  it("returns to recovery after failed auth setup without rerunning the live probe", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.runReadinessProbe.mockResolvedValue({
      ok: false,
      kind: "provider_failed",
      message: "Authentication failed.",
    });
    mocks.selectAnswers.push("auth", "cancel");
    mocks.executeProviderSetupPlan.mockImplementation(async (plan: { actions: readonly Record<string, unknown>[] }) =>
      plan.actions.map((action) => ({ action, status: "failed", detail: "login failed" })));

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runReadinessProbe).toHaveBeenCalledOnce();
    expect(mocks.executeProviderSetupPlan).toHaveBeenCalledOnce();
    await expect(access(join(process.cwd(), "mono-agent.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects dotenv drift during the live probe before committing the scaffold", async () => {
    const envPath = join(process.cwd(), ".env");
    await writeFile(envPath, "OPENAI_API_KEY=durable-before\n", { mode: 0o600 });
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.runReadinessProbe.mockImplementation(async () => {
      await writeFile(envPath, "OPENAI_API_KEY=durable-after\n", { mode: 0o600 });
      return { ok: true };
    });
    mocks.selectAnswers.push("cancel");

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runReadinessProbe).toHaveBeenCalledOnce();
    await expect(access(join(process.cwd(), "mono-agent.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks readiness when dotenv changes in the final check-to-commit race", async () => {
    const envPath = join(process.cwd(), ".env");
    await writeFile(envPath, "OPENAI_API_KEY=durable-before\n", { mode: 0o600 });
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.beforeCommit = async () => {
      await writeFile(envPath, "OPENAI_API_KEY=durable-after\n", { mode: 0o600 });
    };

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.runReadinessProbe).toHaveBeenCalledOnce();
    await expect(access(join(process.cwd(), "mono-agent.config.json"))).resolves.toBeUndefined();
    expect(mocks.confirmAnswers).toEqual([]);
  });

  it("atomically refuses a config created after the wizard started", async () => {
    const configPath = join(process.cwd(), "mono-agent.config.json");
    const concurrent = '{"runtime":{"model":"pi:ollama:concurrent"}}\n';
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.beforeCommit = async () => {
      await writeFile(configPath, concurrent, { mode: 0o600 });
    };

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(await readFile(configPath, "utf8")).toBe(concurrent);
    expect(mocks.confirmAnswers).toEqual([]);
  });

  it("withdraws readiness when the committed config changes during full validation", async () => {
    const configPath = join(process.cwd(), "mono-agent.config.json");
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.validateMonoAgentFolder.mockImplementation(async (options: { readonly cwd: string }) => {
      if (options.cwd === process.cwd()) {
        await writeFile(configPath, '{"runtime":{"model":"pi:ollama:changed"}}\n', { mode: 0o600 });
      }
      return readyReport();
    });

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.confirmAnswers).toEqual([]);
    expect(await readFile(configPath, "utf8")).toContain("pi:ollama:changed");
  });

  it("withdraws readiness when the committed provider dotenv becomes tracked during validation", async () => {
    const envPath = join(process.cwd(), ".env");
    await execFilePromise("git", ["init", "-q"], process.cwd());
    await writeFile(envPath, "OPENAI_API_KEY=durable-provider-key\n", { mode: 0o600 });
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers(),
      moduleSecrets: {},
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.validateMonoAgentFolder.mockImplementation(async (options: { readonly cwd: string }) => {
      if (options.cwd === process.cwd()) {
        await execFilePromise("git", ["add", "-f", ".env"], process.cwd());
      }
      return readyReport();
    });

    await expect(runCli(["init"])).resolves.toBe(1);

    expect(mocks.confirmAnswers).toEqual([]);
    await expect(execFilePromise("git", ["ls-files", "--error-unmatch", ".env"], process.cwd()))
      .resolves.toBeUndefined();
  });

  it("re-prompts an API key during explicit authentication repair", async () => {
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({ model: "pi:opencode-go:kimi-k2.6" }),
      moduleSecrets: {},
      providerSetupSecrets: { "pi-api-key:opencode-go": "rejected-key-one" },
      runProviderSetup: false,
    });
    mocks.runReadinessProbe
      .mockResolvedValueOnce({ ok: false, kind: "provider_failed", message: "Authentication failed." })
      .mockResolvedValueOnce({ ok: true });
    mocks.selectAnswers.push("auth");
    mocks.passwordAnswers.push("replacement-key-two");
    let setupApiKeys: Readonly<Record<string, string | undefined>> | undefined;
    mocks.executeProviderSetupPlan.mockImplementation(async (
      plan: { readonly actions: readonly Record<string, unknown>[] },
      options: { readonly apiKeys?: Readonly<Record<string, string | undefined>> },
    ) => {
      setupApiKeys = options.apiKeys;
      return plan.actions.map((action) => ({ action, status: "ok", detail: "stored" }));
    });
    mocks.confirmAnswers.push(false);

    await expect(runCli(["init"])).resolves.toBe(0);

    expect(setupApiKeys?.["pi-api-key:opencode-go"]).toBe("replacement-key-two");
    expect(mocks.runReadinessProbe).toHaveBeenCalledTimes(2);
  });

  it("marks an in-memory module secret missing when save-incomplete persistence was refused", async () => {
    const envPath = join(process.cwd(), ".env");
    await execFilePromise("git", ["init", "-q"], process.cwd());
    await writeFile(envPath, "MONO_AGENT_TELEGRAM_BOT_TOKEN=\n", { mode: 0o600 });
    await execFilePromise("git", ["add", "-f", ".env"], process.cwd());
    mocks.runInitWizard.mockResolvedValue({
      status: "answers",
      answers: defaultAnswers({
        channels: ["channel:telegram"],
        moduleInputs: { "channel:telegram": { allowedUserIds: "123" } },
      }),
      moduleSecrets: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "in-memory-only" },
      providerSetupSecrets: {},
      runProviderSetup: false,
    });
    mocks.runReadinessProbe.mockResolvedValue({
      ok: false,
      kind: "provider_failed",
      message: "Save for later.",
    });
    mocks.selectAnswers.push("save");

    await expect(runCli(["init"])).resolves.toBe(1);

    const output = vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join("");
    const errorOutput = vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("MONO_AGENT_TELEGRAM_BOT_TOKEN");
    expect(output).toContain("missing");
    expect(output).not.toContain("in-memory-only");
    expect(errorOutput).toContain(`Automatic secret persistence refused because ${envPath} is tracked by git.`);
    expect(errorOutput).not.toContain("in-memory-only");
  });
});

function execFilePromise(file: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { cwd }, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}
