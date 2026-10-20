import { spawn } from "node:child_process";

import { providerSetupActionCommandLine } from "./setup-plan.js";
import type { ProviderSetupAction, ProviderSetupResult } from "./setup-types.js";
export const DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS = 5_000;
const PROVIDER_AUTH_TERM_GRACE_MS = 1_000;
const PROVIDER_AUTH_KILL_SETTLE_MS = 1_000;
const PROVIDER_PREFLIGHT_TERM_GRACE_MS = 250;
const PROVIDER_PREFLIGHT_KILL_SETTLE_MS = 250;
const PROVIDER_DISCOVERY_TERM_GRACE_MS = 250;
const PROVIDER_DISCOVERY_KILL_SETTLE_MS = 250;
const MAX_PROVIDER_DISCOVERY_STDOUT_BYTES = 4 * 1024 * 1024;

interface BoundedProviderCommandResult {
  readonly stdout: string;
}

/**
 * Run a non-interactive provider probe with a hard process-lifecycle bound.
 * Node's execFile timeout sends only SIGTERM and can wait forever when a CLI
 * traps it, so discovery uses explicit TERM-to-KILL escalation and detaches a
 * process whose exit still cannot be confirmed.
 */
export function runBoundedProviderCommand(
  file: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeout: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly abortSignal?: AbortSignal;
    readonly spawn?: typeof spawn;
  },
): Promise<BoundedProviderCommandResult> {
  const timeout = Number.isFinite(options.timeout) && options.timeout > 0
    ? Math.max(1, Math.trunc(options.timeout))
    : 1;
  return new Promise((resolveCommand, rejectCommand) => {
    const spawnImpl = options.spawn ?? spawn;
    const child = spawnImpl(file, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let terminationReason: Error | undefined;
    let childError: Error | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let killSettlementTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (killSettlementTimer !== undefined) clearTimeout(killSettlementTimer);
      options.abortSignal?.removeEventListener("abort", abort);
      child.stdout?.off("data", onStdout);
      if (error === undefined) resolveCommand({ stdout: Buffer.concat(chunks).toString("utf8") });
      else rejectCommand(error);
    };
    const terminate = (reason: Error): void => {
      if (settled || terminationReason !== undefined) return;
      terminationReason = reason;
      try { child.kill("SIGTERM"); } catch { /* escalation remains authoritative */ }
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill("SIGKILL"); } catch { /* settlement deadline remains authoritative */ }
        killSettlementTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.unref?.();
          finish(reason);
        }, PROVIDER_DISCOVERY_KILL_SETTLE_MS);
        killSettlementTimer.unref?.();
      }, PROVIDER_DISCOVERY_TERM_GRACE_MS);
      forceKillTimer.unref?.();
    };
    const abort = (): void => {
      const error = new Error(`${file} provider probe was interrupted.`);
      error.name = "AbortError";
      terminate(error);
    };
    const onStdout = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > MAX_PROVIDER_DISCOVERY_STDOUT_BYTES) {
        terminate(new Error(`${file} provider probe exceeded the ${MAX_PROVIDER_DISCOVERY_STDOUT_BYTES}-byte output limit.`));
        return;
      }
      chunks.push(bytes);
    };

    child.stdout?.on("data", onStdout);
    child.once("error", (error) => {
      childError = error;
      if (child.pid === undefined && terminationReason === undefined) finish(error);
    });
    child.once("close", (code, signal) => {
      if (terminationReason !== undefined) {
        finish(terminationReason);
      } else if (code === 0) {
        finish();
      } else {
        finish(childError ?? new Error(
          signal === null
            ? `${file} provider probe exited ${code ?? "unknown"}.`
            : `${file} provider probe terminated by ${signal}.`,
        ));
      }
    });
    timeoutTimer = setTimeout(
      () => terminate(new Error(`${file} provider probe timed out after ${timeout}ms.`)),
      timeout,
    );
    timeoutTimer.unref?.();
    options.abortSignal?.addEventListener("abort", abort, { once: true });
    if (options.abortSignal?.aborted === true) abort();
  });
}

export async function runSpawnedCommand(
  action: Extract<ProviderSetupAction, { readonly command: readonly [string, ...string[]] }>,
  spawnImpl: typeof spawn,
  cwd: string,
  preflightTimeoutMs = DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<ProviderSetupResult> {
  const [file, ...args] = action.command;
  return new Promise((resolve) => {
    const child = spawnImpl(file, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let killSettlementTimer: NodeJS.Timeout | undefined;
    let childError: Error | undefined;
    let terminationResult: ProviderSetupResult | undefined;
    const interruptedDetail = `${providerSetupActionCommandLine(action)} was interrupted.`;
    const finish = (result: ProviderSetupResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (killSettlementTimer !== undefined) clearTimeout(killSettlementTimer);
      abortSignal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const terminate = (result: ProviderSetupResult) => {
      if (settled || terminationResult !== undefined) return;
      terminationResult = result;
      try { child.kill("SIGTERM"); } catch { /* close/error remains authoritative */ }
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill("SIGKILL"); } catch { /* close/error remains authoritative */ }
        killSettlementTimer = setTimeout(() => {
          child.unref?.();
          finish({
            action,
            status: "failed",
            failureKind: "child_exit_unconfirmed",
            detail:
              `${result.detail.replace(/[.]$/u, "")}; child exit could not be confirmed after SIGKILL. ` +
              "Stop the provider process manually before retrying provider setup.",
          });
        }, action.kind === "preflight" ? PROVIDER_PREFLIGHT_KILL_SETTLE_MS : PROVIDER_AUTH_KILL_SETTLE_MS);
        killSettlementTimer.unref?.();
      }, action.kind === "preflight" ? PROVIDER_PREFLIGHT_TERM_GRACE_MS : PROVIDER_AUTH_TERM_GRACE_MS);
      forceKillTimer.unref?.();
    };
    const abort = () => terminate({ action, status: "failed", detail: interruptedDetail });
    child.once("error", (error) => {
      childError = error;
      // A ChildProcess can emit `error` because signaling an already-running
      // process failed (for example EPERM). That is not proof of exit: retain
      // the TERM→KILL escalation and wait for `close`. A true spawn failure has
      // no pid and can settle immediately when no cancellation is in flight.
      if (terminationResult === undefined && child.pid === undefined) {
        finish({ action, status: "failed", detail: error.message });
      }
    });
    child.once("close", (code, signal) => {
      if (terminationResult !== undefined) {
        finish(terminationResult);
        return;
      }
      if (code === 0) {
        finish({ action, status: "ok", detail: `${providerSetupActionCommandLine(action)} exited 0.` });
        return;
      }
      finish({
        action,
        status: "failed",
        detail: childError?.message ?? (signal === null
          ? `${providerSetupActionCommandLine(action)} exited ${code ?? "unknown"}.`
          : `${providerSetupActionCommandLine(action)} terminated by ${signal}.`),
      });
    });
    if (action.kind === "preflight") {
      timer = setTimeout(() => {
        const detail = `${providerSetupActionCommandLine(action)} timed out after ${preflightTimeoutMs}ms.`;
        terminate({ action, status: "failed", detail });
      }, preflightTimeoutMs);
      timer.unref?.();
    }
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted === true) abort();
  });
}

export async function runHttpAction(
  action: Extract<ProviderSetupAction, { readonly url: string }>,
  fetchImpl: typeof fetch,
  preflightTimeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ProviderSetupResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const interrupted = Symbol("provider-preflight-interrupted");
  let resolveInterrupted: ((value: typeof interrupted) => void) | undefined;
  const interruptedPromise = new Promise<typeof interrupted>((resolve) => {
    resolveInterrupted = resolve;
  });
  const onAbort = () => {
    resolveInterrupted?.(interrupted);
    controller.abort();
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (abortSignal?.aborted === true) onAbort();
    const request = Promise.resolve(fetchImpl(action.url, { signal: controller.signal }));
    // An injected/custom fetch may ignore AbortSignal, so the race itself is the
    // bounded contract. Observe the original promise to avoid late rejections.
    void request.catch(() => undefined);
    const timedOut = Symbol("provider-preflight-timeout");
    const response = action.kind === "preflight"
      ? await Promise.race([
          request,
          interruptedPromise,
          new Promise<typeof timedOut>((resolveTimeout) => {
            timer = setTimeout(() => {
              resolveTimeout(timedOut);
              controller.abort();
            }, preflightTimeoutMs);
            timer.unref?.();
          }),
        ])
      : await Promise.race([request, interruptedPromise]);
    if (response === interrupted) {
      return {
        action,
        status: "failed",
        detail: `${providerSetupActionCommandLine(action)} was interrupted.`,
      };
    }
    if (response === timedOut) {
      return {
        action,
        status: "failed",
        detail: `GET ${action.url} timed out after ${preflightTimeoutMs}ms.`,
      };
    }
    if (response.ok) {
      return { action, status: "ok", detail: `GET ${action.url} returned ${response.status}.` };
    }
    return { action, status: "failed", detail: `GET ${action.url} returned ${response.status}.` };
  } catch (error) {
    return {
      action,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

export function positivePreflightTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_PROVIDER_PREFLIGHT_TIMEOUT_MS;
}
