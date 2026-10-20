import { stat } from "node:fs/promises";

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadBujoModule(): Promise<typeof import("@mono-agent/memory/bujo")> {
  return await import("@mono-agent/memory/bujo");
}

export async function loadMemoryStoreModule(): Promise<typeof import("@mono-agent/memory/store")> {
  return await import("@mono-agent/memory/store");
}

export async function loadMemoryRecallModule(): Promise<typeof import("../../../memory/memory-recall.js")> {
  return await import("../../../memory/memory-recall.js");
}

export function isNativeModuleFailure(error: unknown): boolean {
  try {
    const message = error instanceof Error ? error.message : "";
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code ?? "")
      : "";
    return /better[-_ ]?sqlite|sqlite[-_ ]?vec|node_module_version|native module|dlopen|\.node\b/iu.test(`${code} ${message}`);
  } catch {
    return false;
  }
}
