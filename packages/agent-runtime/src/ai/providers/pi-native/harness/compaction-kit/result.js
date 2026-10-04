// Adapted from @earendil-works/pi-agent-core 0.99.2 (MIT).
// Copyright (c) 2025 Mario Zechner. See agent-runtime/THIRD_PARTY_NOTICES.md.
/** Create a successful {@link Result}. */
export function ok(value) {
    return { ok: true, value };
}
/** Create a failed {@link Result}. */
export function err(error) {
    return { ok: false, error };
}
/** Error returned by compaction helpers. */
export class CompactionError extends Error {
    /** Backend-independent error code. */
    code;
    constructor(code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "CompactionError";
        this.code = code;
    }
}
