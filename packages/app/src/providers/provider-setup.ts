import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  assertOwnerOnlyPersistenceSupported,
  assertPiAuthStoreUnchanged,
  combinePiAuthCleanupError,
  persistPiProviderCredential,
  PiAuthCleanupError,
  piAuthSingleLinkPolicy,
  promotePiAuthStoreWithoutClobber,
  readPiAuthStore,
  syncDirectory,
  syncFile,
  withPiAuthFileLock,
} from "./auth-store-write.js";
import { assertOAuthCredential, assertUnchangedSiblingCredentials } from "./credential-values.js";
import { DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS, positivePreflightTimeout, runHttpAction, runSpawnedCommand } from "./command.js";
import { isProviderSetupPiApiKeyAction, isProviderSetupPiLoginAction, providerSetupActionCommandLine } from "./setup-plan.js";
import type {
  ExecuteProviderSetupOptions,
  PiAuthPromotionHooks,
  ProviderSetupAction,
  ProviderSetupPiApiKeyAction,
  ProviderSetupPiLoginAction,
  ProviderSetupPlan,
  ProviderSetupResult,
} from "./setup-types.js";

export async function executeProviderSetupPlan(
  plan: ProviderSetupPlan,
  options: ExecuteProviderSetupOptions = {},
): Promise<ProviderSetupResult[]> {
  const preflightTimeoutMs = positivePreflightTimeout(options.preflightTimeoutMs);
  const results: ProviderSetupResult[] = [];
  for (const action of plan.actions) {
    if (options.abortSignal?.aborted === true) break;
    const result = isProviderSetupPiApiKeyAction(action)
      ? await runPiApiKeyAction(action, options.apiKeys ?? {}, options.platform ?? process.platform, options)
      : "command" in action
      ? await runCommandAction(
          action,
          options.spawn ?? spawn,
          options.platform ?? process.platform,
          options,
          preflightTimeoutMs,
          options.abortSignal,
        )
      : await runHttpAction(action, options.fetch ?? fetch, preflightTimeoutMs, options.abortSignal);
    results.push(result);
    if (result.failureKind !== undefined) break;
  }
  return results;
}

async function runPiApiKeyAction(
  action: ProviderSetupPiApiKeyAction,
  apiKeys: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  hooks: PiAuthPromotionHooks,
): Promise<ProviderSetupResult> {
  // Secure-store is an explicit mutation and therefore consumes only a value
  // intentionally handed to this action. Merely exporting an environment
  // variable must never cause mono-agent to copy it into auth.json.
  const raw = apiKeys[action.id]
    ?? apiKeys[action.provider]
    ?? (action.persistence === "environment" ? process.env[action.envVar] : undefined);
  const key = raw?.trim();
  if (key === undefined || key.length === 0) {
    return {
      action,
      status: "skipped",
      detail: `${action.envVar} was not provided; skipped saving credentials for ${action.provider}.`,
    };
  }

  if (action.persistence === "environment") {
    return {
      action,
      status: "ok",
      detail: `${action.envVar} is available in the durable environment; the value was not copied into Pi auth.json.`,
    };
  }

  try {
    await persistPiProviderCredential({
      authPath: action.piAuthPath,
      provider: action.provider,
      platform,
      resolveCredential: async () => ({ type: "api_key", key }),
      ...hooks,
    });
    return {
      action,
      status: "ok",
      detail: `Saved API key credentials for ${action.provider} to the Pi auth store.`,
    };
  } catch (error) {
    return {
      action,
      status: "failed",
      ...(error instanceof PiAuthCleanupError ? { failureKind: "cleanup_failed" as const } : {}),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runCommandAction(
  action: Extract<ProviderSetupAction, { readonly command: readonly [string, ...string[]] }>,
  spawnImpl: typeof spawn,
  platform: NodeJS.Platform,
  hooks: PiAuthPromotionHooks,
  preflightTimeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ProviderSetupResult> {
  if (isProviderSetupPiLoginAction(action)) {
    return await runPiLoginAction(action, spawnImpl, platform, hooks, abortSignal);
  }
  return await runSpawnedCommand(action, spawnImpl, action.cwd, preflightTimeoutMs, abortSignal);
}

async function runPiLoginAction(
  action: ProviderSetupPiLoginAction,
  spawnImpl: typeof spawn,
  platform: NodeJS.Platform,
  hooks: PiAuthPromotionHooks,
  abortSignal?: AbortSignal,
): Promise<ProviderSetupResult> {
  let dominantFailure: ProviderSetupResult | undefined;
  let cleanupError: unknown;
  let stagingPath: string | undefined;
  let stagingCleanupCompleted = false;
  let piTaskCompleted = false;
  try {
    assertOwnerOnlyPersistenceSupported(platform);
    return await withPiAuthFileLock(action.piAuthPath, async (authPath, ownerUid, assertLockHeld) => {
      let stagingDir: string | undefined;
      let operationError: unknown;
      try {
        const original = await readPiAuthStore(authPath, piAuthSingleLinkPolicy(ownerUid));
        stagingDir = await mkdtemp(join(dirname(authPath), ".mono-agent-pi-auth-"));
        stagingPath = stagingDir;
        const stagedAuthPath = join(stagingDir, "auth.json");
        if (original.exists) {
          await writeFile(stagedAuthPath, original.contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
        }
        const result = await runSpawnedCommand(
          action,
          spawnImpl,
          stagingDir,
          DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS,
          abortSignal,
        );
        if (result.status !== "ok") {
          dominantFailure = result;
          piTaskCompleted = true;
          return result;
        }

        const staged = await readPiAuthStore(stagedAuthPath, piAuthSingleLinkPolicy(ownerUid));
        if (!staged.exists) {
          throw new Error("Bundled Pi login exited successfully without producing auth.json; the configured store was not changed.");
        }
        const provider = action.id.slice("pi-login:".length);
        assertOAuthCredential(staged.auth[provider], provider);
        assertUnchangedSiblingCredentials(original.auth, staged.auth, provider);
        await assertPiAuthStoreUnchanged(authPath, original, ownerUid);
        await chmod(stagedAuthPath, 0o600);
        await syncFile(stagedAuthPath);
        const hardenedStaged = await readPiAuthStore(stagedAuthPath, piAuthSingleLinkPolicy(ownerUid));
        if (
          !hardenedStaged.exists ||
          hardenedStaged.dev !== staged.dev ||
          hardenedStaged.ino !== staged.ino ||
          hardenedStaged.contents !== staged.contents ||
          ((hardenedStaged.mode ?? 0) & 0o777) !== 0o600
        ) {
          throw new Error("Bundled Pi login output changed while owner-only permissions were applied; the configured store was not changed.");
        }
        await promotePiAuthStoreWithoutClobber(
          stagedAuthPath,
          authPath,
          original,
          ownerUid,
          assertLockHeld,
          hardenedStaged,
          hooks,
        );
        piTaskCompleted = true;
        try {
          await hooks.beforePiAuthPostMutationSync?.(authPath);
          await syncDirectory(dirname(authPath));
        } catch (error) {
          throw new PiAuthCleanupError(
            authPath,
            `credentials were installed but parent-directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return {
          action,
          status: "ok",
          detail: `${providerSetupActionCommandLine(action)} saved credentials to ${action.piAuthPath}.`,
        };
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        if (stagingDir !== undefined) {
          try {
            await hooks.beforePiAuthCleanup?.(stagingDir);
            await rm(stagingDir, { recursive: true, force: true });
            stagingCleanupCompleted = true;
          } catch (error) {
            const stagingCleanupError = new PiAuthCleanupError(
              stagingDir,
              `the credential-bearing OAuth staging directory could not be removed: ${error instanceof Error ? error.message : String(error)}`,
            );
            cleanupError = stagingCleanupError;
            throw combinePiAuthCleanupError(operationError, stagingCleanupError);
          }
        }
      }
    }, hooks);
  } catch (error) {
    if (dominantFailure?.failureKind === "child_exit_unconfirmed") {
      return {
        ...dominantFailure,
        detail: `${dominantFailure.detail} Cleanup also failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (cleanupError !== undefined || piTaskCompleted || error instanceof PiAuthCleanupError) {
      const cleanupPath = error instanceof PiAuthCleanupError
        ? error.path
        : !stagingCleanupCompleted && stagingPath !== undefined
          ? stagingPath
          : `${action.piAuthPath}.mono-agent.lock`;
      return {
        action,
        status: "failed",
        failureKind: "cleanup_failed",
        detail:
          `${dominantFailure?.detail === undefined ? "Provider authentication stopped." : dominantFailure.detail} ` +
          `Temporary credential cleanup for ${cleanupPath} failed: ${error instanceof Error ? error.message : String(error)} ` +
          "Inspect and remove the residue manually before retrying authentication.",
      };
    }
    return {
      action,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
