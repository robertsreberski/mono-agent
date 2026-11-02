/**
 * Internal, serializable app-factory metadata on an MCP spec:
 * { appOwnedTools: { version: 1, aliases: { CanonicalName: ["legacy_name"] } } }.
 * This only restricts tool exposure; it grants no transport or execution authority.
 * External specs without this field retain their existing server-declaration gate.
 */
export function createMcpToolPolicyGuard(
  spec: unknown,
  serverName: string,
  allowedTools?: unknown,
  disallowedTools: readonly string[] = [],
): (toolName: string) => boolean {
  if (spec === null || typeof spec !== "object" || !Object.hasOwn(spec, "appOwnedTools")) return () => true;
  if (!isRecord(spec)) return () => false;
  const descriptor = spec.appOwnedTools;
  if (!isRecord(descriptor) || descriptor.version !== 1 || !isRecord(descriptor.aliases)) return () => false;
  const aliases = new Map<string, readonly string[]>();
  for (const [name, values] of Object.entries(descriptor.aliases)) {
    if (!Array.isArray(values) || !values.every((value): value is string => typeof value === "string")) return () => false;
    aliases.set(name, [...values]);
  }
  // Own policy data before MCP/auth awaits; callers cannot widen a prepared run
  // by mutating a list or marker after registration.
  const allowAll = !Array.isArray(allowedTools);
  const allowed = new Set(Array.isArray(allowedTools) ? allowedTools : []), denied = new Set(disallowedTools);
  return (name) => {
    const names = [name, `mcp__${serverName}__${name}`, `mcp__${serverName}__*`, ...(aliases.get(name) ?? [])];
    return !denied.has("*") && !names.some((value) => denied.has(value))
      && (allowAll || allowed.has("*") || names.some((value) => allowed.has(value)));
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
