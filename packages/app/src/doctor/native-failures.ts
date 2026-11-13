/** Shared with configured-memory doctor; do not classify every failure as ABI mismatch. */
export function isBuiltInMemoryNativeFailure(error: unknown): boolean {
  try {
    const message = error instanceof Error ? error.message : "";
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    return /(?:err_(?:dlopen|module_not_found)|module_not_found|better[-_ ]?sqlite|sqlite[-_ ]?vec|node_module_version|native module|dlopen|\.node\b)/iu.test(`${code} ${message}`);
  } catch { return false; }
}
export function classifyNativeFailure(message: string): { code: string; compiledAbi?: string; requiredAbi?: string } {
  if (/NODE_MODULE_VERSION/i.test(message)) {
    const versions = [...message.matchAll(/NODE_MODULE_VERSION\s+(\d+)/gi)].map((m) => m[1]!);
    return { code: "native_abi_mismatch", ...(versions[0] ? { compiledAbi: versions[0] } : {}), ...(versions[1] ? { requiredAbi: versions[1] } : {}) };
  }
  if (/MODULE_NOT_FOUND|Cannot find (?:package|module)|Could not locate the bindings|could not load.*sharp/i.test(message)) return { code: "native_dependency_missing" };
  return { code: "native_load_failed" };
}
