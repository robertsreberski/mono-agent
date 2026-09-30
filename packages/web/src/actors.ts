import { parseOperatorWebActor, type OperatorWebActor } from "@mono-agent/operator-adapter";

import type { WebUser } from "./auth.js";
import { WebConsoleError } from "./errors.js";

/** The authenticated account, never a browser-supplied attribution object. */
export function webActorForUser(user: WebUser): OperatorWebActor {
  return { schema: 1, role: user.role, sender: { id: user.id, displayName: user.displayName, handle: user.username } };
}

/** Durable snapshots fail closed instead of falling back to legacy owner authority. */
export function parseStoredWebActor(serialized: string | null): OperatorWebActor | undefined {
  if (serialized === null) return undefined;
  try { return parseOperatorWebActor(JSON.parse(serialized)); }
  catch { throw new WebConsoleError("storage_corrupt", "Stored web actor is invalid.", 500); }
}
