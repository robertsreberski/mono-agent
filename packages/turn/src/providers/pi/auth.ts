// @ts-check

import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { resolveOAuthApiKey } from "./oauth-compat.js";

export type PiApiKeyCredential = {
  type: "api_key";
  key?: string;
  env?: {
    [x: string]: any;
  };
};

export type PiOAuthCredential = {
  type: "oauth";
  access?: string;
  refresh?: string;
  expires: number;
  [key: string]: any;
};

export type PiCredential = PiApiKeyCredential | PiOAuthCredential;

export type PiApiKeyResolver = ((provider: string, options?: {
  rejectedAccessToken?: string;
  signal?: AbortSignal;
}) => Promise<string | undefined>) & {
  readCredential?: (provider: string) => Promise<PiCredential | undefined>;
  modifyCredential?: (provider: string, fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>) => Promise<PiCredential | undefined>;
  deleteCredential?: (provider: string) => Promise<void>;
};

const authFileChains = new Map<string, Promise<unknown>>();

export function createPiOAuthApiKeyResolver(options: {
    path?: string;
} = {}): PiApiKeyResolver {
  const configuredAuthPath = typeof options.path === "string" && options.path.trim().length > 0
    ? options.path
    : undefined;
  const authPath = configuredAuthPath ? canonicalizeAuthPath(configuredAuthPath) : undefined;

  async function resolvePiOAuthApiKey(provider: string, options: { rejectedAccessToken?: string; signal?: AbortSignal } = {}) {
    if (!authPath || typeof provider !== "string" || provider.trim().length === 0) {
      return undefined;
    }

    return enqueueAuthFile(authPath, async () => {
      const auth = await readAuthFile(authPath);
      if (auth === undefined || auth[provider] === undefined) {
        return undefined;
      }

      options.signal?.throwIfAborted();
      const credentials = cloneAuth(auth);
      const credential = credentials[provider];
      // Only invalidate the token actually rejected. A queued caller may already
      // have refreshed or replaced it. Never write a synthetic expiry to disk.
      if (options.rejectedAccessToken !== undefined && credential?.type === "oauth"
        && credential.access === options.rejectedAccessToken) {
        credential.expires = 0;
      }
      const result = options.signal === undefined
        ? await resolveOAuthApiKey(provider, credentials)
        : await resolveOAuthApiKey(provider, credentials, options.signal);
      options.signal?.throwIfAborted();
      if (result === null || result === undefined || typeof result.apiKey !== "string" || result.apiKey.length === 0) {
        return undefined;
      }

      if (provider === "openai" && credential.type === "oauth"
        && (typeof result.newCredentials.clientId !== "string" || result.newCredentials.clientId.trim().length === 0)) {
        throw new Error("OpenAI OAuth refresh did not preserve its issued client ID; reconnect ChatGPT");
      }
      auth[provider] = {
        type: "oauth",
        ...result.newCredentials as Omit<typeof result.newCredentials, "type">,
      };
      await writeAuthFile(authPath, auth);
      return result.apiKey;
    });
  }

  resolvePiOAuthApiKey.readCredential = async function readCredential(provider: string) {
    if (!authPath || typeof provider !== "string" || provider.trim().length === 0) {
      return undefined;
    }
    const auth = await readAuthFile(authPath);
    return cloneCredential(auth?.[provider]);
  };

  resolvePiOAuthApiKey.modifyCredential = async function modifyCredential(provider: string, fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>) {
    if (!authPath || typeof provider !== "string" || provider.trim().length === 0) {
      return undefined;
    }
    if (typeof fn !== "function") {
      throw new TypeError("modifyCredential requires a function");
    }
    return enqueueAuthFile(authPath, async () => {
      const auth = (await readAuthFile(authPath)) || {};
      const current = cloneCredential(auth[provider]);
      const next = await fn(current);
      if (next !== undefined) {
        auth[provider] = cloneCredential(next) || next;
        await writeAuthFile(authPath, auth);
        return cloneCredential(auth[provider]);
      }
      return current;
    });
  };

  resolvePiOAuthApiKey.deleteCredential = async function deleteCredential(provider: string) {
    if (!authPath || typeof provider !== "string" || provider.trim().length === 0) {
      return;
    }
    await enqueueAuthFile(authPath, async () => {
      const auth = await readAuthFile(authPath);
      if (!auth || !Object.hasOwn(auth, provider)) return;
      delete auth[provider];
      await writeAuthFile(authPath, auth);
    });
  };

  return resolvePiOAuthApiKey;
}

function enqueueAuthFile<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = authFileChains.get(path) ?? Promise.resolve();
  const next = (async () => {
    await previous.catch(() => {});
    return task();
  })();
  authFileChains.set(path, next.catch(() => {}));
  return next;
}

function canonicalizeAuthPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch (error) {
    if (!isMissingPathError(error as NodeJS.ErrnoException)) {
      return resolved;
    }
  }

  try {
    return join(realpathSync.native(dirname(resolved)), basename(resolved));
  } catch {
    return resolved;
  }
}

function isMissingPathError(error: NodeJS.ErrnoException): boolean {
  return error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function cloneAuth(auth: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(auth).map(([provider, credentials]) => [
      provider,
      cloneCredential(credentials),
    ]),
  );
}

function cloneCredential(credential: any): any {
  return credential && typeof credential === "object" && !Array.isArray(credential)
    ? { ...credential }
    : credential;
}

async function readAuthFile(path: string): Promise<Record<string, any> | undefined> {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
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

// The temp name carries a per-process sequence (not a timestamp) so concurrent
// writers in the same millisecond never collide on the temp path.
let atomicWriteSequence = 0;

async function writeAuthFile(path: string, auth: Record<string, any>): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  atomicWriteSequence += 1;
  const tmpPath = `${path}.tmp-${process.pid}-${atomicWriteSequence}`;
  await writeFile(tmpPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, path);
  await chmod(path, 0o600);
}
