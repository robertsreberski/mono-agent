import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { DoctorStatusExecFile } from "./options.js";

const execFile = promisify(execFileCallback);

export const DOCTOR_STATUS_TIMEOUT_MS = 5_000;
export const DOCTOR_STATUS_MAX_BUFFER_BYTES = 64 * 1024;
export const OLLAMA_WEB_SEARCH_PROBE_MAX_BYTES = 2 * 1024 * 1024;

export const defaultDoctorStatusExecFile: DoctorStatusExecFile = async (file, args, options) => {
  const { stdout } = await execFile(file, [...args], options);
  return { stdout };
};

export const LIVENESS_PROBE_TIMEOUT_MS = 3_000;
