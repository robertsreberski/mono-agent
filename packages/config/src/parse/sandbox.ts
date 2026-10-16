

import {
  createSandboxPolicy,
  SANDBOX_FALLBACKS,
  SANDBOX_MODES,
  SANDBOX_NETWORK_MODES,
  SandboxPolicyError,
} from "@mono-agent/turn/host/sandbox";

import type { SandboxFallback, SandboxMode, SandboxNetworkMode } from "@mono-agent/turn/host/types";

import type { MonoAgentConfig } from "../types.js";

import { MonoAgentConfigError } from "../errors.js";

import { jsonBoolean, jsonChoice, jsonRecord, jsonStringArray } from "./scalars.js";

export function readSandboxConfig(value: unknown, workspace: string): MonoAgentConfig["sandbox"] | undefined {
  const sandbox = jsonRecord(value, "sandbox");
  if (sandbox === undefined) {
    return undefined;
  }
  const network = jsonRecord(sandbox.network, "sandbox.network") ?? {};
  // An empty block configures nothing: it stays absent rather than materializing
  // a default-deny policy the operator never asked for.
  const configured = [
    sandbox.mode,
    network.mode,
    network.allowlist,
    sandbox.readableRoots,
    sandbox.writableRoots,
    sandbox.denyWrite,
    sandbox.fallback,
    sandbox.unsafeAllowHostProcess,
  ].some((field) => field !== undefined);
  if (!configured) {
    return undefined;
  }

  const mode = jsonChoice<SandboxMode>(sandbox.mode, "sandbox.mode", SANDBOX_MODES, "native");
  const networkMode = jsonChoice<SandboxNetworkMode>(network.mode, "sandbox.network.mode", SANDBOX_NETWORK_MODES, "none");
  const fallback = jsonChoice<SandboxFallback>(sandbox.fallback, "sandbox.fallback", SANDBOX_FALLBACKS, "fail-closed");
  // Filesystem scope entries are resolved by the sandbox against `root` (the
  // workspace), so relative entries here mean "relative to the workspace".
  const readableRoots = jsonStringArray(sandbox.readableRoots, "sandbox.readableRoots");
  const writableRoots = jsonStringArray(sandbox.writableRoots, "sandbox.writableRoots");
  const denyWrite = jsonStringArray(sandbox.denyWrite, "sandbox.denyWrite");
  try {
    return createSandboxPolicy({
      mode,
      root: workspace,
      ...(readableRoots.length === 0 ? {} : { readableRoots }),
      ...(writableRoots.length === 0 ? {} : { writableRoots }),
      ...(denyWrite.length === 0 ? {} : { denyWrite }),
      network: {
        mode: networkMode,
        allowlist: jsonStringArray(network.allowlist, "sandbox.network.allowlist"),
      },
      fallback,
      unsafeAllowHostProcess: jsonBoolean(
        sandbox.unsafeAllowHostProcess,
        "sandbox.unsafeAllowHostProcess",
        false,
      ),
    });
  } catch (error) {
    if (error instanceof SandboxPolicyError) {
      throw new MonoAgentConfigError("invalid_json", `Sandbox policy config is invalid: ${error.message}`, {
        path: sandboxPolicyErrorPath(error),
        reason: error.message,
      });
    }
    throw error;
  }
}

function sandboxPolicyErrorPath(error: SandboxPolicyError): string {
  const field = typeof error.details.field === "string" ? error.details.field : undefined;
  if (field === "unsafeAllowHostProcess") {
    return "sandbox.unsafeAllowHostProcess";
  }
  if (field === "readableRoots" || field?.startsWith("readableRoots[")) {
    return "sandbox.readableRoots";
  }
  if (field === "writableRoots" || field?.startsWith("writableRoots[")) {
    return "sandbox.writableRoots";
  }
  if (field === "denyWrite" || field?.startsWith("denyWrite[")) {
    return "sandbox.denyWrite";
  }
  if (field === "network.allowlist" || field?.startsWith("network.allowlist[")) {
    return "sandbox.network.allowlist";
  }
  if (field === "network.mode") {
    return "sandbox.network.mode";
  }
  if (field === "fallback") {
    return "sandbox.fallback";
  }
  if (field === "root") {
    return "runtime.workspace";
  }
  return "sandbox.mode";
}
