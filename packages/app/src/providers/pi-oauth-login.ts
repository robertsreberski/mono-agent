import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";

import { describePiProviderAuth, loginPiOAuth, type PiOAuthLoginCallbacks } from "@mono-agent/turn/ai";
import { getOrCreatePiInstallationId } from "./pi-installation-id.js";

interface PiOAuthLoginIo {
  readonly ask: (question: string) => Promise<string>;
  readonly write: (text: string) => void;
}

interface RunPiOAuthLoginOptions {
  readonly authPath?: string;
  /** Effective durable Pi auth path; never the temporary staged auth.json. */
  readonly deviceIdAuthPath?: string;
  readonly login?: typeof loginPiOAuth;
  readonly io?: PiOAuthLoginIo;
  readonly signal?: AbortSignal;
}

/**
 * Run Pi's provider-owned OAuth implementation with a complete terminal
 * callback surface. In particular, Anthropic races its localhost callback
 * against `onManualCodeInput`; Pi's generic CLI omits that callback even though
 * it prints instructions saying a final redirect URL can be pasted.
 *
 * The raw line is intentionally handed to the provider unchanged. Anthropic's
 * shipped parser extracts code/state from the full URL and validates state
 * against the PKCE verifier before token exchange.
 */
export async function runPiOAuthLogin(
  providerId: string,
  options: RunPiOAuthLoginOptions = {},
): Promise<void> {
  const supportsOAuth = describePiProviderAuth(providerId)?.methods.some((method) => method.type === "oauth");
  if (supportsOAuth !== true) {
    throw new Error(`Unknown bundled Pi OAuth provider: ${providerId}`);
  }
  assertPiOAuthLoginPersistenceSupported(process.platform);
  if (providerId === "openai" && options.deviceIdAuthPath === undefined) {
    throw new Error("ChatGPT sign-in requires the effective durable Pi auth path.");
  }
  const deviceId = providerId === "openai"
    ? await getOrCreatePiInstallationId(requireDeviceIdAuthPath(options.deviceIdAuthPath)) : undefined;

  const readline = options.io === undefined
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const io: PiOAuthLoginIo = options.io ?? {
    ask: async (question) => await new Promise<string>((resolve, reject) => {
      if (readline === undefined) reject(new Error("OAuth terminal input is unavailable."));
      else readline.question(question, resolve);
    }),
    write: (text) => process.stdout.write(text),
  };

  try {
    const callbacks: PiOAuthLoginCallbacks = {
      signal: options.signal ?? new AbortController().signal,
      onAuth: (info) => {
        io.write(`\nOpen this URL in your browser:\n${info.url}\n`);
        if (info.instructions !== undefined) io.write(`${info.instructions}\n`);
        io.write("\n");
      },
      onDeviceCode: (info) => {
        io.write(`\nOpen this URL in your browser:\n${info.verificationUri}\n`);
        io.write(`Enter code: ${info.userCode}\n\n`);
      },
      onProgress: (message) => io.write(`${message}\n`),
      onManualCodeInput: async () => await io.ask(
        providerId === "openai"
          ? "If the localhost:1455 callback does not complete (including remote browsers or a busy port), paste the entire final redirect URL from the browser address bar:\n> "
          : "Paste the final redirect URL or authorization code " +
            "(its OAuth state will be validated), or wait for the localhost callback:\n> ",
      ),
      onSelect: async (prompt) => {
        io.write(`\n${prompt.message}\n`);
        prompt.options.forEach((option, index) => io.write(`  ${index + 1}. ${option.label}\n`));
        const answer = await io.ask(`Enter number (1-${prompt.options.length}): `);
        const selected = prompt.options[Number.parseInt(answer, 10) - 1]?.id;
        if (selected === undefined) throw new Error("No option was selected.");
        return selected;
      },
      onPrompt: async (prompt) => await io.ask(
        `${prompt.message}${prompt.placeholder === undefined ? "" : ` (${prompt.placeholder})`}: `,
      ),
    };
    // 0.83.0's OAuthCredential already carries `type: "oauth"`. Drop it from the
    // spread so the tag can stay written first, keeping the on-disk key order
    // byte-identical to what earlier versions produced.
    const { type: _tagged, ...credentials } = await (options.login ?? loginPiOAuth)(providerId, callbacks, deviceId === undefined ? undefined : { getDeviceId: () => deviceId });
    const authPath = options.authPath ?? "auth.json";
    const auth = await readAuth(authPath);
    await writeAuth(authPath, `${JSON.stringify({
      ...auth,
      [providerId]: { type: "oauth", ...credentials },
    }, null, 2)}\n`);
    io.write(`\nCredentials saved to ${authPath}\n`);
  } finally {
    readline?.close();
  }
}

function requireDeviceIdAuthPath(path: string | undefined): string {
  if (path === undefined) throw new Error("ChatGPT sign-in requires the effective durable Pi auth path.");
  return path;
}

/** @internal Exported only for deterministic platform-policy tests. */
export function assertPiOAuthLoginPersistenceSupported(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new Error(
      "Direct Pi OAuth credential persistence is unavailable on Windows because symlink-safe owner-only writes cannot be verified.",
    );
  }
}

async function readAuth(path: string): Promise<Record<string, unknown>> {
  let handle: FileHandle | undefined;
  let contents: string;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    if (!(await handle.stat()).isFile()) {
      throw new Error(`${path} must be a regular file.`);
    }
    contents = await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  } finally {
    await handle?.close();
  }
  const parsed: unknown = JSON.parse(contents);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

async function writeAuth(path: string, contents: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_CREAT,
      0o600,
    );
    if (!(await handle.stat()).isFile()) {
      throw new Error(`${path} must be a regular file.`);
    }
    // Tighten an existing file through the already-open inode before replacing
    // its contents, so new credentials are never exposed under an old mode.
    await handle.chmod(0o600);
    // O_WRONLY opens at offset zero. Truncate explicitly so a shorter JSON
    // replacement cannot retain bytes from the prior credential store.
    await handle.truncate(0);
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle?.close();
  }
}
