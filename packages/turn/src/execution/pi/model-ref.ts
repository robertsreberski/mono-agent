// @ts-check

export function assertEngineTurnModelRef(modelRef: import("../../contracts/model.js").RuntimeModelRef): void {
  // Direct kernel callers may bypass the parser, so malformed references must
  // still fail before the sole bridge receives them.
  if (
    typeof modelRef?.provider !== "string"
    || modelRef.provider.length === 0
    || typeof modelRef.model !== "string"
    || modelRef.model.length === 0
    || modelRef.reference !== `${modelRef.provider}:${modelRef.model}`
  ) {
    throw new Error("unsupported model reference: expected <provider>:<model>");
  }
}
