import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ToolHistoryWriterError } from "./errors.js";

export function assertSecureReadableDirectory(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history directory must be a non-symlink directory.");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && Number(info.uid) !== uid) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history directory must be owned by the current user.");
  }
  if (process.platform !== "win32" && (Number(info.mode) & 0o777) !== 0o700) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history directory must have mode 0700.");
  }
}

export function assertSecureReadableFile(path: string): number {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || Number(info.nlink) !== 1) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history database must be a single-link non-symlink regular file.");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && Number(info.uid) !== uid) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history database must be owned by the current user.");
  }
  if (process.platform !== "win32" && (Number(info.mode) & 0o777) !== 0o600) {
    throw new ToolHistoryWriterError("history_security_invalid", "Tool history database must have mode 0600.");
  }
  return Number(info.size);
}

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

export function canonicalHistoryRoot(path: string): string {
  const normalized = resolve(path);
  mkdirSync(normalized, { recursive: true, mode: 0o700 });
  assertSecureReadableDirectory(normalized);
  return realpathSync(normalized);
}

export function requestedArtifactRoot(value: string | undefined, historyRoot: string): string {
  const requested = value ?? join(historyRoot, "..", "artifacts", "tool-output");
  if (!isAbsolute(requested)) throw new TypeError("tool history artifact root must be absolute.");
  return resolve(requested);
}

export function normalizeId(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > 4 * 1024
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty control-free string no larger than 4096 bytes.`);
  }
  return value.trim();
}
