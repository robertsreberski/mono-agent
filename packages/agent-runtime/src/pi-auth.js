import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getOAuthApiKey } from "@earendil-works/pi-ai/oauth";

export function createPiOAuthApiKeyResolver(options = {}) {
  const authPath = typeof options.path === "string" && options.path.trim().length > 0
    ? options.path
    : undefined;

  return async function resolvePiOAuthApiKey(provider) {
    if (!authPath || typeof provider !== "string" || provider.trim().length === 0) {
      return undefined;
    }

    const auth = await readAuthFile(authPath);
    if (auth === undefined || auth[provider] === undefined) {
      return undefined;
    }

    const result = await getOAuthApiKey(provider, cloneAuth(auth));
    if (result === null || result === undefined || typeof result.apiKey !== "string" || result.apiKey.length === 0) {
      return undefined;
    }

    auth[provider] = {
      type: "oauth",
      ...result.newCredentials,
    };
    await writeAuthFile(authPath, auth);
    return result.apiKey;
  };
}

function cloneAuth(auth) {
  return Object.fromEntries(
    Object.entries(auth).map(([provider, credentials]) => [
      provider,
      credentials && typeof credentials === "object" && !Array.isArray(credentials)
        ? { ...credentials }
        : credentials,
    ]),
  );
}

async function readAuthFile(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new Error(`Unable to parse Pi auth file at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`Unable to parse Pi auth file at ${path}: expected a JSON object`);
}

async function writeAuthFile(path, auth) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, path);
  await chmod(path, 0o600);
}
