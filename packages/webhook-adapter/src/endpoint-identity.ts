import { WebhookAdapterError } from "./server.js";

/**
 * Ceiling on one endpoint identity string (its `name`, its `path`), in UTF-8 bytes.
 *
 * An endpoint's identity is not private to the adapter: the name keys `summary.invokeUrls`
 * and the path is the value inside it, and that map is logged on every channel start
 * (`app-controller-channels.ts`) and rendered by `mono-agent status`
 * (`cli-background-command.ts`). Neither was bounded, so a single config field wrote a
 * megabyte into a durable, routinely-shared operator surface on every start.
 *
 * The number is derived rather than picked. The dominant source of an endpoint name is the
 * stem of a `webhook/<name>.md` file, which POSIX `NAME_MAX` already caps at 255 bytes — so
 * adopting the same cap for an inline `name` refuses nothing that can be authored as a file,
 * and keeps the two authoring surfaces from disagreeing about what a name may be. The path is
 * held to the same bound: its last segment is the default name, and 255 bytes is two orders of
 * magnitude past any real route (`/webhook/invoke` is 15).
 *
 * This REJECTS rather than truncates. An identity is not a diagnostic echo: truncating one
 * silently collides two endpoints and changes which route a request reaches, and a config
 * error at load is the fail-visible option.
 */
const MAX_ENDPOINT_IDENTITY_BYTES = 255;

/**
 * Control, format, line- and paragraph-separator code points. Each is invisible or moves the
 * cursor, which is what lets an identity restyle the status line quoting it or forge a second
 * line inside the start log. A bound alone does not cover this: 40 printable bytes and one
 * newline is still a forged line.
 */
const UNPRINTABLE_IDENTITY_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const invalidConfig = (message: string, details?: Record<string, unknown>): WebhookAdapterError =>
  new WebhookAdapterError("invalid_config", message, details);

/** The identity fields of an endpoint, as much of one as this check needs to see. */
interface EndpointIdentity {
  readonly name: string;
  readonly path: string;
}

/**
 * Assert one endpoint's identity is bounded, printable, single-line text.
 *
 * This lives in its own module because BOTH endpoint sources have to run it, and each has a
 * duplicate check of its own that would otherwise quote an unbounded value first: the folder
 * loader rejects two files sharing a name, and the merge step rejects a name or path shared
 * across sources. An identity that is too large to print is not a duplicate problem, so it has
 * to be settled where the endpoint is BUILT -- ahead of every duplicate check -- or the
 * earliest-firing diagnostic wins and emits the megabyte the bound exists to prevent.
 * (`config.ts` cannot own it: `endpoints-dir.ts` is its dependency, not the other way round.)
 *
 * The path is checked before the name so the name's diagnostic can identify its endpoint by an
 * already-validated path; neither diagnostic quotes the value it rejected, because quoting an
 * unbounded value back is the defect being fixed.
 */
export function assertEndpointIdentity(endpoint: EndpointIdentity, source: string): void {
  assertIdentityString(endpoint.path, `Webhook endpoint path from ${source}`, { source });
  assertIdentityString(endpoint.name, `Webhook endpoint "${endpoint.path}" name`, {
    source,
    path: endpoint.path,
  });
}

function assertIdentityString(value: string, subject: string, details: Record<string, unknown>): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_ENDPOINT_IDENTITY_BYTES) {
    throw invalidConfig(
      `${subject} is ${String(bytes)} bytes; the maximum is ${String(MAX_ENDPOINT_IDENTITY_BYTES)}.`,
      { ...details, bytes, max: MAX_ENDPOINT_IDENTITY_BYTES },
    );
  }
  if (UNPRINTABLE_IDENTITY_CHARACTERS.test(value)) {
    throw invalidConfig(`${subject} must be printable text on a single line.`, details);
  }
}
