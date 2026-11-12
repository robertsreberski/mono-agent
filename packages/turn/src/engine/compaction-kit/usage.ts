// Adapted from @earendil-works/pi-agent-core 0.99.2 (MIT).
// Copyright (c) 2025 Mario Zechner. See harness/THIRD_PARTY_NOTICES.md.

export function addUsage(left: any, right: any) {
    return {
        input: left.input + right.input,
        output: left.output + right.output,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite: left.cacheWrite + right.cacheWrite,
        ...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
            ? {}
            : { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
        ...(left.reasoning === undefined && right.reasoning === undefined
            ? {}
            : { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
        totalTokens: left.totalTokens + right.totalTokens,
        cost: {
            input: left.cost.input + right.cost.input,
            output: left.cost.output + right.cost.output,
            cacheRead: left.cost.cacheRead + right.cost.cacheRead,
            cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
            total: left.cost.total + right.cost.total,
        },
    };
}

interface KnownSummaryUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cacheWrite1h?: number;
    reasoning?: number;
    /** Numeric fields are known subtotals, not a claim of complete billing. */
    partial?: true;
}

/** Preserve the native usage shape after a truncated request with missing usage.
 * Request-row accounting remains authoritative for unknown billing; zeros here
 * are only the known subtotal, explicitly marked partial when anything is absent.
 */
export function sumKnownSummaryUsage(...parts: unknown[]): KnownSummaryUsage {
    const sum: KnownSummaryUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const known = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
    for (const part of parts) {
        const usage = part as Partial<KnownSummaryUsage> | undefined;
        if (usage?.partial) sum.partial = true;
        let tokens = 0, cost = 0;
        for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
            const count = usage?.[field], amount = usage?.cost?.[field];
            if (known(count)) { sum[field] += count; tokens += count; } else sum.partial = true;
            if (known(amount)) { sum.cost[field] += amount; cost += amount; } else sum.partial = true;
        }
        if (known(usage?.totalTokens)) sum.totalTokens += usage.totalTokens;
        else { sum.totalTokens += tokens; sum.partial = true; }
        if (known(usage?.cost?.total)) sum.cost.total += usage.cost.total;
        else { sum.cost.total += cost; sum.partial = true; }
        for (const field of ["cacheWrite1h", "reasoning"] as const) {
            const value = usage?.[field];
            if (known(value)) sum[field] = (sum[field] ?? 0) + value;
            else if (value !== undefined) sum.partial = true;
        }
    }
    return sum;
}
