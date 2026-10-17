import { MCP_APP_SUPPORTED_VERSIONS } from "@mono-agent/contracts";

export const APP_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,35}$/u;

export function isSupportedProtocolVersion(
  value: unknown,
): value is (typeof MCP_APP_SUPPORTED_VERSIONS)[number] {
  return typeof value === "string"
    && (MCP_APP_SUPPORTED_VERSIONS as readonly string[]).includes(value);
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function serializeBoundedJsonLine(value: unknown, maxBytes: number): string {
  const serialized = `${JSON.stringify(value) ?? "null"}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new RangeError("MCP App persisted metadata exceeded its byte limit.");
  }
  return serialized;
}
