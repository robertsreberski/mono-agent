import { chmod, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import {
  getOAuthProvider,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";

export interface PiOAuthLoginIo {
  readonly ask: (question: string) => Promise<string>;
  readonly write: (text: string) => void;
}

export interface RunPiOAuthLoginOptions {
  readonly authPath?: string;
  readonly provider?: OAuthProviderInterface;
  readonly io?: PiOAuthLoginIo;
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
  const provider = options.provider ?? getOAuthProvider(providerId);
  if (provider === undefined || provider.id !== providerId) {
    throw new Error(`Unknown bundled Pi OAuth provider: ${providerId}`);
  }

  const readline = options.io === undefined
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const io: PiOAuthLoginIo = options.io ?? {
    ask: async (question) => await new Promise<string>((resolve) => readline!.question(question, resolve)),
    write: (text) => process.stdout.write(text),
  };

  try {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        io.write(`\nOpen this URL in your browser:\n${info.url}\n`);
        if (info.instructions !== undefined) io.write(`${info.instructions}\n`);
        io.write("\n");
      },
      onDeviceCode: (info) => {
        io.write(`\nOpen this URL in your browser:\n${info.verificationUri}\n`);
        io.write(`Enter code: ${info.userCode}\n\n`);
      },
      onPrompt: async (prompt) => await io.ask(
        `${prompt.message}${prompt.placeholder === undefined ? "" : ` (${prompt.placeholder})`}: `,
      ),
      onManualCodeInput: async () => await io.ask(
        "Paste the final redirect URL or authorization code " +
        "(its OAuth state will be validated), or wait for the localhost callback:\n> ",
      ),
      onSelect: async (prompt) => {
        io.write(`\n${prompt.message}\n`);
        prompt.options.forEach((option, index) => io.write(`  ${index + 1}. ${option.label}\n`));
        const answer = await io.ask(`Enter number (1-${prompt.options.length}): `);
        return prompt.options[Number.parseInt(answer, 10) - 1]?.id;
      },
      onProgress: (message) => io.write(`${message}\n`),
    };
    const credentials = await provider.login(callbacks);
    const authPath = options.authPath ?? "auth.json";
    const auth = await readAuth(authPath);
    await writeFile(authPath, `${JSON.stringify({
      ...auth,
      [providerId]: { type: "oauth", ...credentials },
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(authPath, 0o600);
    io.write(`\nCredentials saved to ${authPath}\n`);
  } finally {
    readline?.close();
  }
}

async function readAuth(path: string): Promise<Record<string, unknown>> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(contents);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}
