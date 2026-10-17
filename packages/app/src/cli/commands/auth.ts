import { dirname, resolve } from "node:path";
import process from "node:process";

import { readMonoAgentConfigJson } from "@mono-agent/config";

import { canonicalBackgroundConfigPath } from "../../service/background/target.js";
import type { ParsedCliArgs } from "../../cli-args.js";
import { resolveEffectivePiAuthPath } from "../../first-run-readiness.js";
import { executeProviderSetupPlan } from "../../providers/provider-setup.js";
import {
  isProviderSetupPiApiKeyAction,
  planProviderSetup,
} from "../../providers/setup-plan.js";
import { inspectPiAuthStore } from "../../providers/pi-auth-store-inspection.js";
import { withScopedPreflightCancellation } from "../../setup/cancellation.js";
import { nonEmptyEnv } from "../../setup/provider-setup-gate.js";
import { printProviderSetupPlan } from "../../setup/render.js";
import * as p from "@clack/prompts";
import * as ui from "../../ui.js";

export async function runAuth(args: ParsedCliArgs): Promise<number> {
  const [subcommand, provider, ...extra] = args.positionals;
  if (subcommand !== "login" || provider === undefined || extra.length > 0) {
    process.stderr.write(ui.errorLine(
      "Usage: mono-agent auth login <provider> [--pi-auth-path <path>] [--auth-method oauth|api-key] [--api-key-stdin] [--config <path>].",
    ));
    return 2;
  }

  const cwd = process.cwd();
  const configPath = await canonicalBackgroundConfigPath(cwd, args.configPath);
  let configuredPiAuthPath: string;
  try {
    configuredPiAuthPath = await resolvePiAuthPathForLogin({
      configPath,
      cwd,
      ...(args.piAuthPath === undefined ? {} : { piAuthPath: args.piAuthPath }),
    });
  } catch (error) {
    process.stderr.write(ui.errorLine(
      `Cannot resolve the Pi auth path from ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return 1;
  }
  if (args.authMethod !== undefined && provider !== "openai") {
    process.stderr.write(ui.errorLine("--auth-method is currently supported for openai only."));
    return 2;
  }
  let selectedMethod = args.authMethod;
  if (provider === "openai") {
    if (args.apiKeyStdin === true && selectedMethod === "oauth") {
      process.stderr.write(ui.errorLine("--api-key-stdin cannot be combined with --auth-method oauth."));
      return 2;
    }
    if (args.apiKeyStdin === true) selectedMethod = "api-key";
    if (selectedMethod === undefined) {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        process.stderr.write(ui.errorLine("Choose --auth-method oauth or --auth-method api-key in a non-interactive terminal."));
        return 2;
      }
      const answer = await p.select<"oauth" | "api-key">({
        message: "OpenAI authentication method (one stored credential per provider)",
        options: [
          { value: "oauth", label: "Sign in with ChatGPT" },
          { value: "api-key", label: "OpenAI API key" },
        ],
      });
      if (p.isCancel(answer)) return 130;
      selectedMethod = answer;
    }
    const inspection = await inspectPiAuthStore(configuredPiAuthPath);
    const existing = inspection.status === "ok" ? inspection.auth.openai : undefined;
    const oldType = typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as { type?: unknown }).type : undefined;
    if ((oldType === "oauth" || oldType === "api_key")
      && oldType !== (selectedMethod === "oauth" ? "oauth" : "api_key")
      && process.stdin.isTTY === true && process.stdout.isTTY === true) {
      const confirmed = await p.confirm({ message: `Replace stored OpenAI ${oldType === "oauth" ? "ChatGPT sign-in" : "API key"} after successful ${selectedMethod === "oauth" ? "ChatGPT sign-in" : "API-key entry"}?` });
      if (p.isCancel(confirmed) || !confirmed) return 130;
    }
  }
  const plan = planProviderSetup({
    modelRefs: [`${provider}:credential-setup`],
    cwd,
    piAuthPath: configuredPiAuthPath,
    forceAuthentication: true,
    ...(selectedMethod === undefined ? {} : { piAuthMethods: { [provider]: selectedMethod } }),
  });
  if (plan.actions.length === 0) {
    process.stderr.write(ui.errorLine(
      `Provider \`${provider}\` has no interactive auth method in the bundled Pi provider catalog.`,
    ));
    return 2;
  }

  const apiKeyActions = plan.actions.filter(isProviderSetupPiApiKeyAction);
  if (args.apiKeyStdin === true && apiKeyActions.length !== 1) {
    process.stderr.write(ui.errorLine(
      "--api-key-stdin is only supported when the selected provider has one bundled API-key login action.",
    ));
    return 2;
  }

  process.stdout.write("\n" + ui.heading("Pi authentication"));
  printProviderSetupPlan(plan);

  let apiKeys: Readonly<Record<string, string>> | undefined;
  const apiKeyAction = apiKeyActions[0];
  if (apiKeyAction !== undefined) {
    let apiKey: string;
    if (args.apiKeyStdin === true) {
      if (process.stdin.isTTY === true) {
        process.stderr.write(ui.errorLine(
          "--api-key-stdin requires redirected standard input. Omit the flag to enter the key in a masked prompt.",
        ));
        return 2;
      }
      try {
        apiKey = await readApiKeyFromStdin(process.stdin);
      } catch {
        process.stderr.write(ui.errorLine(
          `Could not read a valid ${apiKeyAction.envVar} value from standard input; no credentials were written.`,
        ));
        return 1;
      }
    } else {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        process.stderr.write(ui.errorLine(
          `Cannot securely prompt for ${apiKeyAction.envVar} without an interactive TTY. ` +
          `Run this command in a terminal, or pipe the value explicitly with --api-key-stdin; no credentials were written.`,
        ));
        return 1;
      }
      const answer = await p.password({
        message: `Enter ${apiKeyAction.label} (${apiKeyAction.envVar})`,
        validate: (value) => apiKeyInputProblem(value ?? ""),
        clearOnError: true,
      });
      if (p.isCancel(answer)) {
        process.stderr.write(ui.errorLine("Authentication was cancelled; no credentials were written."));
        return 130;
      }
      apiKey = answer.trim();
    }
    apiKeys = { [apiKeyAction.id]: apiKey };
  }

  process.stdout.write(ui.style.dim("Press Ctrl-C once to interrupt authentication safely.\n"));
  const execution = await withScopedPreflightCancellation(async (abortSignal) => ({
    results: await executeProviderSetupPlan(plan, {
      ...(apiKeys === undefined ? {} : { apiKeys }),
      abortSignal,
    }),
    interrupted: abortSignal.aborted,
  }), { keypress: false });
  const { results } = execution;
  for (const result of results) {
    const badge = execution.interrupted && result.status === "failed"
      ? ui.badge("waiting")
      : result.status === "ok"
        ? ui.badge("ok")
        : ui.badge("error");
    process.stdout.write(`${badge}${result.action.label}: ${result.detail}\n`);
  }
  if (results.some((result) => result.failureKind !== undefined)) {
    process.stderr.write(ui.errorLine(
      "Provider setup ended in an unconfirmed process or credential-cleanup state. Follow the reported manual cleanup guidance before retrying; automatic recovery is disabled.",
    ));
    return 130;
  }
  if (execution.interrupted) {
    process.stderr.write(ui.errorLine("Authentication was interrupted; temporary credentials were cleaned up."));
    return 130;
  }
  return results.every((result) => result.status === "ok") ? 0 : 1;
}

const MAX_STANDALONE_API_KEY_BYTES = 65_536;

function apiKeyInputProblem(value: string): string | undefined {
  const normalized = value.trim();
  if (normalized.length === 0) return "API key is required.";
  if (normalized.includes("\0") || /[\r\n]/u.test(normalized)) return "API key must be a single non-empty line.";
  if (Buffer.byteLength(normalized, "utf8") > MAX_STANDALONE_API_KEY_BYTES) return "API key is too large.";
  return undefined;
}

/**
 * Read one explicitly redirected API key without consulting ambient provider
 * environment variables. A single trailing line ending from `echo` is accepted;
 * embedded newlines, NUL bytes, empty input, and unbounded input fail closed.
 */
export async function readApiKeyFromStdin(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input as NodeJS.ReadableStream & AsyncIterable<string | Uint8Array>) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_STANDALONE_API_KEY_BYTES + 2) throw new Error("API key input is too large.");
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
  const problem = apiKeyInputProblem(value);
  if (problem !== undefined) throw new Error(problem);
  return value.trim();
}

export async function resolvePiAuthPathForLogin(options: {
  readonly piAuthPath?: string;
  readonly configPath: string;
  readonly cwd?: string;
}): Promise<string> {
  // A missing config is represented by readMonoAgentConfigJson as `missing`; a
  // malformed or unreadable config throws and must remain visible to operators.
  const result = await readMonoAgentConfigJson(options.configPath);
  const configured = result.missing ? undefined : result.json.providers?.piAuthPath;
  return resolveEffectivePiAuthPath({
    cwd: options.cwd ?? dirname(resolve(options.configPath)),
    ...(nonEmptyEnv(options.piAuthPath) ? { explicitPath: options.piAuthPath } : {}),
    ...(nonEmptyEnv(configured) ? { configPath: configured } : {}),
  });
}
