import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  ensureOwnerOnlyDirectory,
  readBoundedOwnerOnlyFile,
  writeJsonAtomic,
} from "./continuation-store-fs.js";

export const ACP_SESSION_AUTHORIZATION_SCHEMA = "mono-agent.acp-session.v1" as const;
const MAX_ACP_SESSION_AUTHORIZATION_BYTES = 4 * 1024;

export interface AcpSessionAuthorization {
  readonly schema: typeof ACP_SESSION_AUTHORIZATION_SCHEMA;
  readonly sessionId: string;
  readonly sourceId: string;
  readonly workspace: string;
  readonly createdAt: string;
}

export function acpSessionAuthorizationsRoot(artifactDir: string): string {
  return join(dirname(resolve(artifactDir)), "acp-sessions");
}

export async function createAcpSessionAuthorization(
  artifactDir: string,
  input: Omit<AcpSessionAuthorization, "schema" | "createdAt">,
): Promise<AcpSessionAuthorization> {
  const root = acpSessionAuthorizationsRoot(artifactDir);
  await ensureOwnerOnlyDirectory(root);
  const record: AcpSessionAuthorization = {
    schema: ACP_SESSION_AUTHORIZATION_SCHEMA,
    ...input,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(
    acpSessionAuthorizationPath(root, input.sessionId),
    record,
    true,
    MAX_ACP_SESSION_AUTHORIZATION_BYTES,
  );
  return record;
}

export async function loadAcpSessionAuthorization(
  artifactDir: string,
  sessionId: string,
): Promise<AcpSessionAuthorization | undefined> {
  const root = acpSessionAuthorizationsRoot(artifactDir);
  await ensureOwnerOnlyDirectory(root);
  const path = acpSessionAuthorizationPath(root, sessionId);
  let raw: string;
  try {
    raw = await readBoundedOwnerOnlyFile(
      path,
      MAX_ACP_SESSION_AUTHORIZATION_BYTES,
      "ACP session authorization",
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("ACP session authorization is not valid JSON.", { cause: error });
  }
  if (!isAcpSessionAuthorization(parsed) || parsed.sessionId !== sessionId) {
    throw new Error("ACP session authorization has an invalid schema or identity.");
  }
  return parsed;
}

function acpSessionAuthorizationPath(root: string, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
  return join(root, `${digest}.json`);
}

function isAcpSessionAuthorization(value: unknown): value is AcpSessionAuthorization {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "createdAt,schema,sessionId,sourceId,workspace") return false;
  if (
    record.schema !== ACP_SESSION_AUTHORIZATION_SCHEMA
    || typeof record.sessionId !== "string"
    || record.sessionId.length === 0
    || typeof record.sourceId !== "string"
    || record.sourceId.length === 0
    || typeof record.workspace !== "string"
    || !isAbsolute(record.workspace)
    || typeof record.createdAt !== "string"
  ) return false;
  try {
    return new Date(record.createdAt).toISOString() === record.createdAt;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
