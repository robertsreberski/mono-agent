// Child-process entry for the restart arm: one live turn in a fresh Node
// process over the parent's forked durable workspace. Reads one JSON request on
// stdin and writes one JSON result on stdout; never prints request content.
import { productionModules, runLiveTurn, prepareLedgerCheckpoint, scriptedModels } from "./continuity-runner.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
try {
  const input = JSON.parse(raw);
  if (input.plan?.probeMode === "lookup-allowed-v1" && (input.mode !== "offline" || input.type !== "probe"
    || input.plan.lookup?.maxTurns !== input.plan.lookup?.budget?.callBudget + 2 || input.plan.lookup.maxTurns > 100
    || input.plan.lookup.deadlineMs !== 600000 || input.plan.limits.perLiveTurnTimeoutMs !== 690000 || input.plan.lookup.childWatchdogMs !== 720000)) {
    throw Object.assign(new Error("invalid_lookup_child_contract"), { code: "invalid_lookup_child_contract" });
  }
  const modules = await productionModules(input.root);
  const clock = { value: new Date(input.clockIso) };
  let live;
  if (input.type === "preparation") {
    const reader = modules.host.parseMonoRuntimeModelReference(input.plan.reader.model);
    const alternate = modules.host.parseMonoRuntimeModelReference(input.plan.alternateBinding.model);
    const scripted = scriptedModels(modules.pi, [reader, alternate]);
    const route = options => ({ piResolvedModel: scripted.route(options).model, piResolvedModels: scripted.models,
      compaction: { ...(options.compaction ?? {}), enabled: false } });
    live = await prepareLedgerCheckpoint({ ...input, modules, reader, alternate, scripted, route, clock });
  } else if (input.type === "probe") live = await runLiveTurn({ modules, ...input, clock });
  else throw new Error("invalid_child_request_type");
  process.stdout.write(JSON.stringify({ pid: process.pid, ...live }), () => process.exit(0));
} catch (error) {
  // Emit the code-only receipt before exiting, including any accumulated content-free state.
  const failure = typeof error?.code === "string" ? error.code : "failed";
  const detail = process.env.CONTINUITY_DEBUG === "1" ? `\n${error?.stack ?? error}` : "";
  process.stderr.write(`continuity-probe-child: ${failure}${detail}\n`, () => {
    process.stdout.write(JSON.stringify({ failure, lookup: error?.lookup ?? null }), () => process.exit(1));
  });
}
