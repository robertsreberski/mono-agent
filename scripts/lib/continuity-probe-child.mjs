// Child-process entry for the restart arm: one live turn in a fresh Node
// process over the parent's forked durable workspace. Reads one JSON request on
// stdin and writes one JSON result on stdout; never prints request content.
import { productionModules, runLiveTurn } from "./continuity-runner.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
try {
  const input = JSON.parse(raw);
  const modules = await productionModules(input.root);
  const live = await runLiveTurn({ modules, ...input, clock: { value: new Date(input.clockIso) } });
  process.stdout.write(JSON.stringify({ pid: process.pid, ...live }), () => process.exit(0));
} catch {
  process.stderr.write("continuity-probe-child: failed\n", () => process.exit(1));
}
