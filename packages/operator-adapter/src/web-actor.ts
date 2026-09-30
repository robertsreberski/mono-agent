import type { AgentMessageSender } from "@mono-agent/agent-contracts";

/** Version of the trusted operator web-actor attribution boundary. */
export const OPERATOR_WEB_ACTOR_VERSION = 1;

/** Authenticated by the console; accepted only at the trusted operator boundary. */
export interface OperatorWebActor {
  readonly schema: typeof OPERATOR_WEB_ACTOR_VERSION;
  readonly role: "admin" | "user";
  readonly sender: Pick<AgentMessageSender, "id" | "displayName" | "handle"> & {
    readonly id: string;
    readonly displayName: string;
  };
}

/** Strict JSON boundary validation; identity never comes from request metadata. */
export function parseOperatorWebActor(value: unknown): OperatorWebActor {
  const actor = record(value);
  const sender = record(actor?.sender);
  if (actor === undefined || !onlyKeys(actor, ["schema", "role", "sender"])
    || actor.schema !== OPERATOR_WEB_ACTOR_VERSION
    || (actor.role !== "admin" && actor.role !== "user")
    || sender === undefined || !onlyKeys(sender, ["id", "displayName", "handle"])
    || !boundedString(sender.id, 256) || !boundedString(sender.displayName, 256)
    || (sender.handle !== undefined && !boundedString(sender.handle, 256))) {
    throw new TypeError("webActor must be a valid v1 web actor with bounded sender strings.");
  }
  return {
    schema: OPERATOR_WEB_ACTOR_VERSION,
    role: actor.role,
    sender: {
      id: sender.id,
      displayName: sender.displayName,
      ...(sender.handle === undefined ? {} : { handle: sender.handle }),
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}
