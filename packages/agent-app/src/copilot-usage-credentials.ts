import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { usageRecord } from "./provider-usage-mappers.js";

const FILE_BYTES = 64 * 1024;
const TOKEN_BYTES = 4096;
const PROCESS_BYTES = 8192;
interface ProcessOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly encoding: "utf8";
  readonly shell: false;
  readonly windowsHide: true;
}
interface DiscoveryOptions {
  readonly home?: () => string;
  /** Must read at most limit bytes; the default also rejects nonregular files. */
  readonly readFile?: (path: string, limit: number) => Promise<string | undefined>;
  readonly run?: (file: string, args: string[], options: ProcessOptions) => Promise<{ stdout: string; stderr: string }>;
  readonly env?: NodeJS.ProcessEnv;
}
function token(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean.length > 0 && clean.length <= TOKEN_BYTES && /^[\x21-\x7e]+$/.test(clean) ? clean : undefined;
}
async function readBounded(path: string, limit: number): Promise<string | undefined> {
  // Nonblocking open avoids hanging on a FIFO; read limit+1 also fences growth after stat.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) return undefined;
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    return length <= limit ? bytes.subarray(0, length).toString("utf8") : undefined;
  } finally { await file.close(); }
}
/** Read only the active github.com host token; aliases, duplicate keys and malformed YAML fail closed. */
function ghFileToken(text: string): string | undefined {
  try {
    const document = parseDocument(text, { schema: "failsafe", uniqueKeys: true });
    if (document.errors.length) return undefined;
    const data = usageRecord(document.toJS({ maxAliasCount: 0 }));
    return token(usageRecord(data["github.com"]).oauth_token);
  } catch { return undefined; }
}
/** Private, prompt-free local lookup. No store writes, logging, environment tokens or vendor calls. */
export function createCopilotCredentialDiscovery(options: DiscoveryOptions = {}): () => Promise<string | undefined> {
  const readFile = options.readFile ?? readBounded;
  const run = options.run ?? ((file, args, settings) => new Promise((resolve, reject) => {
    execFile(file, args, settings, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  }));
  return async () => {
    try {
      const home = (options.home ?? homedir)();
      const read = async (relative: string): Promise<string | undefined> => {
        try {
          const text = await readFile(join(home, ".config", relative), FILE_BYTES);
          return text !== undefined && Buffer.byteLength(text) <= FILE_BYTES ? text : undefined;
        } catch { return undefined; }
      };
      for (const name of ["apps.json", "hosts.json"]) {
        const text = await read(`github-copilot/${name}`);
        if (text === undefined) continue;
        try {
          const data = usageRecord(JSON.parse(text));
          for (const key of Object.keys(data).sort()) {
            if (key !== "github.com" && !/^github\.com:[A-Za-z0-9_-]+$/.test(key)) continue;
            const found = token(usageRecord(data[key]).oauth_token);
            if (found) return found;
          }
        } catch { /* Malformed source is unavailable, never diagnostic output. */ }
      }
      const ghText = await read("gh/hosts.yml");
      const fromFile = ghText === undefined ? undefined : ghFileToken(ghText);
      if (fromFile) return fromFile;
      const env = { ...(options.env ?? process.env), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GH_HOST: "github.com" };
      delete (env as NodeJS.ProcessEnv).GH_TOKEN;
      delete (env as NodeJS.ProcessEnv).GITHUB_TOKEN;
      const result = await run("gh", ["auth", "token", "--hostname", "github.com"], {
        env, timeout: 2000, maxBuffer: PROCESS_BYTES, encoding: "utf8", shell: false, windowsHide: true,
      });
      if (Buffer.byteLength(result.stdout) > PROCESS_BYTES || Buffer.byteLength(result.stderr) > PROCESS_BYTES) return undefined;
      return token(result.stdout);
    } catch { return undefined; }
  };
}
