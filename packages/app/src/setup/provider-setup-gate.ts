import { stat } from "node:fs/promises";
import process from "node:process";

import { detectProviderCredentialStates } from "../providers/credential-state.js";
import { executeProviderSetupPlan } from "../provider-setup.js";
import {
  isProviderSetupPiApiKeyAction,
  planProviderSetup,
} from "../providers/setup-plan.js";
import type {
  ProviderCredentialState,
  ProviderSetupPlan,
  ProviderSetupResult,
} from "../providers/setup-types.js";
import { inspectPiAuthStore } from "../pi-auth-store-inspection.js";
import { printProviderSetupPlan } from "./render.js";
import * as ui from "../ui.js";

export function nonEmptyEnv(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

type InitProviderSetupStatus = "ok" | "failed" | "skipped" | "interrupted" | "fatal";

interface RunProviderSetupBeforeInitOptions {
  readonly modelRefs: readonly string[];
  readonly cwd: string;
  readonly auth: boolean;
  readonly dryRun: boolean;
  readonly piAuthPath?: string;
  readonly apiKeys?: Readonly<Record<string, string | undefined>>;
  readonly forceAuthentication?: boolean;
  readonly credentialStates?: Readonly<Record<string, ProviderCredentialState | undefined>>;
  /** Values parsed from the destination `.env`; ambient shell credentials are intentionally excluded. */
  readonly persistedEnv?: Readonly<Record<string, string | undefined>>;
  readonly piApiKeyPersistenceByProvider?: Readonly<Record<string, "secure-store" | "environment" | undefined>>;
  readonly piAuthMethods?: Readonly<Record<string, "oauth" | "api-key" | undefined>>;
  readonly abortSignal?: AbortSignal;
  readonly execute?: (plan: ProviderSetupPlan) => Promise<readonly ProviderSetupResult[]>;
}

export async function runProviderSetupBeforeInit(
  options: RunProviderSetupBeforeInitOptions,
): Promise<InitProviderSetupStatus> {
  const credentialStates = options.credentialStates !== undefined
    ? options.credentialStates
    : options.forceAuthentication === true || !options.auth || options.dryRun
      ? undefined
    : await detectProviderCredentialStates({
        modelRefs: options.modelRefs,
        cwd: options.cwd,
        ...(options.piAuthPath === undefined ? {} : { piAuthPath: options.piAuthPath }),
        ...(options.persistedEnv === undefined ? {} : { persistedEnv: options.persistedEnv }),
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      });
  const plan = planProviderSetup({
    ...options,
    ...(credentialStates === undefined ? {} : { credentialStates }),
    ...(options.forceAuthentication === undefined ? {} : { forceAuthentication: options.forceAuthentication }),
  });
  if (options.auth && !options.dryRun && options.piAuthMethods?.openai === undefined
    && options.modelRefs.some((ref) => ref.startsWith("openai:"))
    && credentialStates?.openai !== "credential_detected") {
    process.stderr.write(ui.hint("OpenAI authentication needs an explicit method: run mono-agent auth login openai --auth-method oauth|api-key before using this route."));
  }
  if (plan.actions.length === 0) {
    return "skipped";
  }
  if (options.dryRun) {
    process.stdout.write("\n" + ui.heading("Provider setup"));
    process.stdout.write(ui.style.dim("Dry run - provider auth/preflight commands were not launched.\n"));
    printProviderSetupPlan(plan);
    return "skipped";
  }
  if (!options.auth) {
    return "skipped";
  }
  const environmentOpenAIAction = plan.actions.find((action) => isProviderSetupPiApiKeyAction(action)
    && action.provider === "openai" && action.persistence === "environment");
  if (environmentOpenAIAction !== undefined && isProviderSetupPiApiKeyAction(environmentOpenAIAction)) {
    const inspection = await inspectPiAuthStore(environmentOpenAIAction.piAuthPath);
    if (inspection.status === "ok" && inspection.auth.openai !== undefined) {
      process.stderr.write(ui.errorLine("A stored OpenAI credential overrides OPENAI_API_KEY. Choose secure-store API-key replacement or explicitly remove the old credential before selecting environment persistence."));
      return "failed";
    }
  }

  process.stdout.write("\n" + ui.heading("Provider setup"));
  printProviderSetupPlan(plan);
  if (options.abortSignal !== undefined) {
    process.stdout.write(ui.style.dim("Press Ctrl-C once to interrupt authentication safely.\n"));
  }
  const results = await (options.execute ?? ((setupPlan) => executeProviderSetupPlan(setupPlan, {
    ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  })))(plan);
  const interrupted = options.abortSignal?.aborted === true;
  for (const result of results) {
    const badge = interrupted && result.status === "failed"
      ? ui.badge("waiting")
      : result.status === "ok"
      ? ui.badge("ok")
      : result.status === "skipped"
        ? ui.style.dim("- ")
        : ui.badge("error");
    process.stdout.write(`${badge}${result.action.label}: ${result.detail}\n`);
  }
  if (results.some((result) => result.failureKind !== undefined)) {
    process.stderr.write(ui.errorLine(
      "Provider setup ended in an unconfirmed process or credential-cleanup state. Follow the reported manual cleanup guidance before retrying; automatic recovery is disabled.",
    ));
    return "fatal";
  }
  if (interrupted) {
    process.stderr.write(ui.errorLine("Provider setup was interrupted."));
    return "interrupted";
  }
  if (results.some((result) => result.status === "failed")) {
    process.stderr.write(ui.errorLine("Provider setup failed; init stopped before writing files."));
    return "failed";
  }
  return "ok";
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
