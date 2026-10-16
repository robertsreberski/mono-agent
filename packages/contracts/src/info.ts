

/**
 * Maximum serialized size of an agent's `/v1/info` body.
 *
 * Load-bearing in every direction, which is why it lives here rather than beside
 * any one user. The operator adapter sheds optional fields to stay under it; BOTH
 * consumers — the console's operator client and the TUI's `RemoteAgentResponder`
 * — read at most this many bytes and reject a larger body wholesale. A producer
 * that exceeded a consumer that had drifted smaller would not degrade the agent
 * — it would show it OFFLINE, on a 5 s poll, behind a debug-level log, and a
 * consumer with no bound at all would buffer whatever it was handed on every one
 * of those polls. One export removes both possibilities.
 */
export const MAX_INFO_BODY_BYTES = 1024 * 1024;

/**
 * Wire bounds for `/v1/info`'s provider summary, shared for the same reason as
 * {@link MAX_INFO_BODY_BYTES}: two independently chosen limits on one wire lose
 * content silently, and neither half can see the other's number.
 *
 * They were chosen independently once, and both ways cost the operator a
 * provider. The producer built the summary against a 256-byte id bound while
 * the console dropped anything over 128. And the producer admitted the agent's
 * OWN route providers first — the ones every model selection actually needs —
 * into a list the console then cut at 64, so a 71-entry catalog handed the
 * console 64 declared vendors and not the route provider the prioritization
 * existed to save.
 *
 * A count window is not a licence to truncate arbitrarily: the producer must
 * place what the console cannot do without inside the first
 * {@link MAX_INFO_PROVIDER_ITEMS} entries, and the console parses that same
 * window. Bytes stay bounded by the producer's own provider slice and, behind
 * it, {@link MAX_INFO_BODY_BYTES}.
 */
export const MAX_INFO_PROVIDER_ITEMS = 64;

/**
 * Byte bound on one provider id / label in `/v1/info.providers`.
 *
 * A display bound, never a validity one: config validation length-bounds
 * neither, so a 129-byte provider id is a route that resolves and runs. The
 * console must therefore accept everything the catalog is willing to publish,
 * or the operator loses a working provider to a number nobody chose together.
 */
export const MAX_INFO_PROVIDER_ID_BYTES = 256;

/** Byte bound on one provider label; an over-long label degrades to the id. */
export const MAX_INFO_PROVIDER_LABEL_BYTES = 256;
