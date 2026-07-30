import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";

import type { AuthInteraction, OAuthAuth } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export interface PiOAuthLoginIo {
  readonly ask: (question: string) => Promise<string>;
  readonly write: (text: string) => void;
}

export interface RunPiOAuthLoginOptions {
  readonly authPath?: string;
  readonly provider?: OAuthAuth;
  readonly io?: PiOAuthLoginIo;
}

/**
 * pi-ai 0.83.0 removed the standalone OAuth registry (`getOAuthProvider`); a
 * provider's OAuth implementation now hangs off the provider itself. Providers
 * without OAuth support (e.g. `opencode-go`) resolve to undefined.
 */
function findPiOAuthAuth(providerId: string): OAuthAuth | undefined {
  return builtinProviders().find((provider) => provider.id === providerId)?.auth.oauth;
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
  // `OAuthAuth` carries no id of its own — identity is established by the
  // lookup, which is why the old `provider.id !== providerId` guard is gone.
  const oauth = options.provider ?? findPiOAuthAuth(providerId);
  if (oauth === undefined) {
    throw new Error(`Unknown bundled Pi OAuth provider: ${providerId}`);
  }
  assertPiOAuthLoginPersistenceSupported(process.platform);

  const readline = options.io === undefined
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const io: PiOAuthLoginIo = options.io ?? {
    ask: async (question) => await new Promise<string>((resolve) => readline!.question(question, resolve)),
    write: (text) => process.stdout.write(text),
  };

  try {
    const interaction: AuthInteraction = {
      notify: (event) => {
        if (event.type === "auth_url") {
          io.write(`\nOpen this URL in your browser:\n${event.url}\n`);
          if (event.instructions !== undefined) io.write(`${event.instructions}\n`);
          io.write("\n");
          return;
        }
        if (event.type === "device_code") {
          io.write(`\nOpen this URL in your browser:\n${event.verificationUri}\n`);
          io.write(`Enter code: ${event.userCode}\n\n`);
          return;
        }
        io.write(`${event.message}\n`);
      },
      prompt: async (prompt) => {
        if (prompt.type === "manual_code") {
          return await io.ask(
            "Paste the final redirect URL or authorization code " +
            "(its OAuth state will be validated), or wait for the localhost callback:\n> ",
          );
        }
        if (prompt.type === "select") {
          io.write(`\n${prompt.message}\n`);
          prompt.options.forEach((option, index) => io.write(`  ${index + 1}. ${option.label}\n`));
          const answer = await io.ask(`Enter number (1-${prompt.options.length}): `);
          const selected = prompt.options[Number.parseInt(answer, 10) - 1]?.id;
          // The old callback could resolve undefined here; `prompt()` must
          // return a string and rejects on cancellation instead.
          if (selected === undefined) throw new Error("No option was selected.");
          return selected;
        }
        return await io.ask(
          `${prompt.message}${prompt.placeholder === undefined ? "" : ` (${prompt.placeholder})`}: `,
        );
      },
    };
    // 0.83.0's OAuthCredential already carries `type: "oauth"`. Drop it from the
    // spread so the tag can stay written first, keeping the on-disk key order
    // byte-identical to what earlier versions produced.
    const { type: _tagged, ...credentials } = await oauth.login(interaction);
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
