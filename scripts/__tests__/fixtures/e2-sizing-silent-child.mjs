// IPC fail-closed regression: the parent must refuse unless a matching result
// arrives AND the child exits 0. Fictional report; no sizing is performed.
process.once("message", sizing => {
  if (sizing.summary === "faux-short") { process.disconnect(); return; } // exit 0, no result
  process.exitCode = 1; // a delivered result followed by a failing exit
  process.send({ type: "result", pid: process.pid, report: { schema: "continuity-e2-sizing-v3", qualification: true, branches: [] } }, () => process.disconnect());
});
