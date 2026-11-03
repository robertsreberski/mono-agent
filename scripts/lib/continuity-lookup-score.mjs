// Lookup reporting is separate from recall-only/ledger qualification statistics.
export function summarizeLookup(trials, plan) {
  const slots = [];
  for (const trace of plan.corpus.traces) for (const probeId of trace.probes) for (const { id: arm } of plan.arms) for (let repeat = 1; repeat <= plan.repeats; repeat++) {
    const matching = trials.filter(trial => trial.traceId === trace.id && trial.probeId === probeId && trial.arm === arm && trial.repeat === repeat);
    const trial = matching.length === 1 ? matching[0] : null;
    const lookup = trial?.lookup;
    const reference = plan.lookup.budget.paths.find(path => path.traceId === trace.id && path.probeId === probeId && path.arm === arm && (!plan.lookup.role || path.role === undefined || path.role === plan.lookup.role.id));
    slots.push({ traceId: trace.id, probeId, arm, repeat, status: trial?.status ?? (matching.length > 1 ? "duplicate" : "missing"),
      sourceAvailability: lookup?.source?.availability ?? "unknown",
      budgetFeasibility: lookup?.budgetFeasibility?.classification ?? reference?.feasibility.classification ?? "unknown",
      exactAccuracy: trial?.status === "completed" ? lookup?.exactAccuracy ?? null : null,
      witnessedRecovery: trial?.status === "completed" && lookup?.witnessedRecovery === true,
      calls: lookup?.calls ?? null, bytes: lookup?.bytes ?? null, durationMs: trial?.durationMs ?? null,
      exhaustion: lookup?.exhausted ?? null, failure: trial?.failure ?? null });
  }
  const countBy = (rows, key) => Object.fromEntries([...new Set(rows.map(row => row[key]))].map(value => [value, rows.filter(row => row[key] === value).length]));
  const stats = (rows, key) => {
    const values = rows.map(row => row[key]).filter(value => typeof value === "number");
    return { n: values.length, total: values.reduce((a, b) => a + b, 0), max: values.length ? Math.max(...values) : null };
  };
  return { purpose: "Offline mechanics self-check; not model quality, causal recovery or treatment benefit", slots,
    arms: Object.fromEntries(plan.arms.map(({ id }) => {
      const rows = slots.filter(row => row.arm === id), exact = rows.filter(row => row.budgetFeasibility !== "budget-infeasible" && row.exactAccuracy !== null);
      const failedFeasible = rows.filter(row => row.status === "failed" && row.budgetFeasibility === "feasible").length;
      const exactWithFailuresN = exact.length + failedFeasible;
      return [id, { planned: rows.length, statuses: countBy(rows, "status"), sourceAvailability: countBy(rows, "sourceAvailability"),
        budgetFeasibility: countBy(rows, "budgetFeasibility"), exact: { n: exact.length, correct: exact.filter(row => row.exactAccuracy).length, accuracy: exact.length ? exact.filter(row => row.exactAccuracy).length / exact.length : null },
        exactWithFailures: { n: exactWithFailuresN, correct: exact.filter(row => row.exactAccuracy).length, accuracy: exactWithFailuresN ? exact.filter(row => row.exactAccuracy).length / exactWithFailuresN : null },
        failedFeasible,
        witnessedRecovery: rows.filter(row => row.witnessedRecovery).length,
        calls: stats(rows, "calls"), bytes: stats(rows, "bytes"), latencyMs: stats(rows, "durationMs"),
        latencyExhaustion: rows.filter(row => row.exhaustion === "latency").length,
        callExhaustion: rows.filter(row => row.exhaustion === "calls").length, byteExhaustion: rows.filter(row => row.exhaustion === "bytes").length,
        hardWatchdogFailures: rows.filter(row => row.failure === "restart_child_timeout").length,
        // Reference infeasibility is a protocol limitation, not a reader failure.
        readerFailures: failedFeasible }];
    })) };
}
export function renderLookupMarkdown(summary) {
  return `\n\nLookup mechanics (not treatment benefit):\n\n| Arm | Planned slots | Source availability | Budget feasibility | Exact correct/n | Exact with failures correct/n | Failed feasible | Witnessed recovery | Calls | Bytes | Latency exhausted |\n|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|\n${Object.entries(summary.arms).map(([arm, row]) => `| ${arm} | ${row.planned} | ${JSON.stringify(row.sourceAvailability)} | ${JSON.stringify(row.budgetFeasibility)} | ${row.exact.correct}/${row.exact.n} | ${row.exactWithFailures.correct}/${row.exactWithFailures.n} | ${row.failedFeasible} | ${row.witnessedRecovery} | ${row.calls.total} | ${row.bytes.total} | ${row.latencyExhaustion} |`).join("\n")}\n`;
}
