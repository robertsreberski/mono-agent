import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

import type { EffortLevel } from "@mono-agent/config";

import { credentialNeutralProviderStatusEnvironment } from "./provider-setup.js";

export interface CodexCatalogModel {
  readonly id: string;
  readonly displayName: string;
  readonly supportedEfforts: readonly EffortLevel[];
  readonly defaultEffort?: EffortLevel;
  readonly isDefault?: boolean;
}

const SUPPORTED_EFFORTS = new Set<EffortLevel>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedCatalogText(value: unknown, limit: number): string {
  const normalized = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim()
    : "";
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function safeDiscoveryProcessEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/** Exact non-secret environment used by live Codex model/list discovery. */
export function codexModelDiscoveryEnvironment(
  persistedEnv: Readonly<Record<string, string | undefined>> = {},
  shellEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const neutral = credentialNeutralProviderStatusEnvironment(shellEnv, persistedEnv);
  return {
    ...safeDiscoveryProcessEnv(shellEnv),
    HOME: neutral.HOME ?? homedir(),
    ...(neutral.CODEX_HOME === undefined ? {} : { CODEX_HOME: neutral.CODEX_HOME }),
  };
}

export function normalizeEffort(value: unknown): EffortLevel | undefined {
  const normalized = value === "off" ? "none" : typeof value === "string" ? value : "";
  return SUPPORTED_EFFORTS.has(normalized as EffortLevel) ? normalized as EffortLevel : undefined;
}

export function normalizeEfforts(values: readonly unknown[]): EffortLevel[] {
  return [...new Set(values.map(normalizeEffort).filter((value): value is EffortLevel => value !== undefined))];
}

export function normalizeCodexCatalog(rows: readonly unknown[]): CodexCatalogModel[] {
  const result: CodexCatalogModel[] = [];
  const seen = new Set<string>();
  for (const raw of rows.slice(0, 1_000)) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (id.length === 0 || id.length > 160 || seen.has(id)) continue;
    const supportedRows = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts.map((entry) => isRecord(entry) ? entry.reasoningEffort : entry)
      : [];
    const supportedEfforts = normalizeEfforts(supportedRows);
    const normalizedDefault = normalizeEffort(raw.defaultReasoningEffort);
    seen.add(id);
    result.push({
      id,
      displayName: boundedCatalogText(raw.displayName, 160) || id,
      supportedEfforts,
      ...(normalizedDefault === undefined ? {} : { defaultEffort: normalizedDefault }),
      ...(typeof raw.isDefault === "boolean" ? { isDefault: raw.isDefault } : {}),
    });
  }
  return result;
}

export async function requestCodexModelList(
  timeoutMs: number,
  environment: Readonly<Record<string, string | undefined>>,
  abortSignal?: AbortSignal,
): Promise<CodexCatalogModel[]> {
  const child = spawn(
    "codex",
    ["app-server", "--listen", "stdio://", "-c", "project_doc_max_bytes=0"],
    {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...environment },
    },
  );
  const lines = createInterface({ input: child.stdout });
  return await new Promise<CodexCatalogModel[]>((resolveResult, rejectResult) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const ignoreStdinError = () => undefined;
    child.stdin.on("error", ignoreStdinError);
    const childClosedWithin = async (milliseconds: number): Promise<boolean> => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      return await new Promise<boolean>((resolveClosed) => {
        const onClose = () => {
          clearTimeout(closeTimer);
          resolveClosed(true);
        };
        const closeTimer = setTimeout(() => {
          child.off("close", onClose);
          resolveClosed(false);
        }, milliseconds);
        closeTimer.unref?.();
        child.once("close", onClose);
      });
    };
    const stopChild = async () => {
      lines.removeAllListeners("line");
      lines.close();
      try { child.stdin.end(); } catch { /* best effort */ }
      if (await childClosedWithin(25)) return;
      try { child.kill("SIGTERM"); } catch { /* best effort */ }
      if (await childClosedWithin(250)) return;
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      if (!await childClosedWithin(250)) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.unref();
      }
    };
    let settle!: (error: Error | undefined, models?: CodexCatalogModel[]) => Promise<void>;
    const onChildError = () => void settle(new Error("Codex app-server is unavailable."));
    const onChildClose = () => void settle(new Error("Codex app-server closed before returning models."));
    const onAbort = () => {
      const error = new Error("Codex model catalog discovery was interrupted.");
      error.name = "AbortError";
      void settle(error);
    };
    settle = async (error: Error | undefined, models: CodexCatalogModel[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onChildError);
      child.off("close", onChildClose);
      abortSignal?.removeEventListener("abort", onAbort);
      await stopChild();
      child.stdin.off("error", ignoreStdinError);
      if (error === undefined) resolveResult(models);
      else rejectResult(error);
    };
    const writeMessage = (message: unknown) => {
      if (settled || child.stdin.destroyed || child.stdin.writableEnded) return;
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* bounded shutdown handles the process */ }
    };
    timer = setTimeout(
      () => void settle(new Error("Codex model catalog discovery timed out.")),
      Math.max(250, Math.min(10_000, timeoutMs)),
    );
    timer.unref?.();
    child.once("error", onChildError);
    child.once("close", onChildClose);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      if (typeof message.method === "string" && (typeof message.id === "string" || typeof message.id === "number")) {
        writeMessage({
          id: message.id,
          error: { code: -32601, message: "Model catalog discovery does not support server requests." },
        });
        return;
      }
      if (message.id === 1 && isRecord(message.result)) {
        writeMessage({
          id: 2,
          method: "model/list",
          params: { includeHidden: false, limit: 1_000 },
        });
        return;
      }
      if (message.id !== 2) return;
      if (!isRecord(message.result) || !Array.isArray(message.result.data)) {
        void settle(new Error("Codex app-server returned an invalid model catalog."));
        return;
      }
      void settle(undefined, normalizeCodexCatalog(message.result.data));
    });
    writeMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "mono-agent", title: "mono-agent", version: "0" },
        capabilities: { experimentalApi: true },
      },
    });
    if (abortSignal?.aborted === true) onAbort();
  });
}
