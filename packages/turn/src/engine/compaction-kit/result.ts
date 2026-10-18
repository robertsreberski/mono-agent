// Adapted from @earendil-works/pi-agent-core 0.99.2 (MIT).
// Copyright (c) 2025 Mario Zechner. See harness/THIRD_PARTY_NOTICES.md.
export function ok<T>(value: T): { ok: true; value: T; error?: never; } {
    return { ok: true, value };
}
export function err<E>(error: E): { ok: false; error: E; value?: never; } {
    return { ok: false, error };
}
/** Error returned by compaction helpers. */
export class CompactionError extends Error {
    /** Backend-independent error code. */
    code: any;
    constructor(code: any, message: any, cause?: any) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "CompactionError";
        this.code = code;
    }
}
