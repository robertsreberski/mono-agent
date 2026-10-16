import { readSettingsJson, SettingsJsonError, writeSettingsJson } from "@mono-agent/contracts";

import { MonoAgentConfigError } from "./errors.js";
import { assertNoRetiredMonoAgentConfigJson } from "./retired-fields.js";

import type { MonoAgentConfigJson } from "./json-types.js";

interface ReadMonoAgentConfigJsonResult {
  readonly json: MonoAgentConfigJson;
  /** sha-256 of the parsed content (or empty string when the file is missing). */
  readonly version: string;
  /** Absolute path actually read. */
  readonly path: string;
  /** True when the file did not exist on disk. */
  readonly missing: boolean;
  /** Duplicate object-key paths in the original JSON source. */
  readonly duplicateKeyPaths: readonly string[];
}

/**
 * Read a JSON config file. Missing file returns an empty config rather than
 * throwing. Resolution still validates required fields and applies built-in defaults.
 */
export async function readMonoAgentConfigJson(path: string): Promise<ReadMonoAgentConfigJsonResult> {
  let result: Awaited<ReturnType<typeof readSettingsJson>>;
  try {
    result = await readSettingsJson(path);
  } catch (error) {
    throw toConfigError(error, path);
  }
  assertNoRetiredMonoAgentConfigJson(result.json);
  return {
    ...result,
    json: result.json as MonoAgentConfigJson,
  };
}

/**
 * Write a sparse JSON patch through the generic settings writer. It writes to
 * `<path>.tmp`, renames over the target and attempts to set mode 0o600. It does
 * not fsync; failure cleanup attempts to unlink the temporary file.
 */
export async function writeMonoAgentConfigJson(input: {
  readonly path: string;
  readonly patch: MonoAgentConfigJson;
}): Promise<{ readonly version: string }> {
  try {
    return await writeSettingsJson({
      path: input.path,
      patch: input.patch,
    });
  } catch (error) {
    throw toConfigError(error, input.path);
  }
}

function toConfigError(error: unknown, path: string): MonoAgentConfigError {
  if (error instanceof SettingsJsonError) {
    return new MonoAgentConfigError("invalid_env", error.message, {
      path,
      reason: error.message,
    });
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new MonoAgentConfigError("invalid_env", reason, { path, reason });
}
