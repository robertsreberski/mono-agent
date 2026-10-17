import { readFile } from "node:fs/promises";

import { invalidWebConsoleName, isWebTheme } from "../../web-service-definition.js";
import { WEB_SERVICE_SCHEMA } from "./types.js";
import type { WebServiceRecord, WebServiceRecordRead } from "./types.js";

export async function readServiceRecord(path: string): Promise<WebServiceRecordRead> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", detail: "the web service record is unreadable; repair or remove ~/.mono-agent/web/service.json" };
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    return { kind: "invalid", detail: "the web service record is malformed; repair or remove ~/.mono-agent/web/service.json" };
  }
  if (!isRecord(value) || value.schema !== WEB_SERVICE_SCHEMA || typeof value.host !== "string"
    || !Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535
    || (value.theme !== undefined && !isWebTheme(value.theme))
    || (value.name !== undefined
      && (typeof value.name !== "string" || invalidWebConsoleName(value.name) !== undefined))
    || typeof value.updatedAt !== "string") {
    return { kind: "invalid", detail: "the web service record has an invalid schema; repair or remove ~/.mono-agent/web/service.json" };
  }
  return { kind: "valid", record: value as unknown as WebServiceRecord, contents };
}

export async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
