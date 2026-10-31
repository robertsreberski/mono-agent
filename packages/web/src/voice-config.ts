import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { WebConsoleError } from "./errors.js";

/** Server-only OpenAI-compatible local transcription endpoint or operator-managed proxy. */
export interface WebVoiceConfig {
  readonly transcription: {
    readonly endpoint: string;
    readonly model: string;
    readonly language?: string;
    readonly timeoutMs?: number;
  };
}

function invalid(): never {
  throw new WebConsoleError("invalid_voice_config", "Invalid voice configuration. Check voice.json permissions and transcription endpoint, model, language and timeoutMs (100–120000).", 400);
}

export function parseVoiceConfig(value: unknown): WebVoiceConfig {
  if (!record(value) || Object.keys(value).some((key) => key !== "transcription")) invalid();
  const input = value.transcription;
  if (!record(input) || Object.keys(input).some((key) => !["endpoint", "model", "language", "timeoutMs"].includes(key))) invalid();
  if (typeof input.endpoint !== "string" || input.endpoint.length > 2048) invalid();
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); } catch { invalid(); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) invalid();
  if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200 || /[\r\n\0]/u.test(input.model)) invalid();
  if (input.language !== undefined && (typeof input.language !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/u.test(input.language))) invalid();
  if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 120_000)) invalid();
  return { transcription: { endpoint: endpoint.href, model: input.model.trim(), ...(input.language === undefined ? {} : { language: input.language as string }), timeoutMs: (input.timeoutMs as number | undefined) ?? 120_000 } };
}

/** Read without following symlinks; validate before acquiring the console lease. */
export async function loadVoiceConfig(root: string, override?: WebVoiceConfig | false): Promise<WebVoiceConfig | undefined> {
  if (override === false) return undefined;
  if (override !== undefined) return parseVoiceConfig(override);
  let handle;
  try { handle = await open(join(root, "voice.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    invalid();
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 8192 || (info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid())) invalid();
    const bytes = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 8192) invalid();
    return parseVoiceConfig(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } catch { invalid(); }
  finally { await handle.close(); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
