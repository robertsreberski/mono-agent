// IPC start gate: the controller fsyncs the reservation and child identity first.
// The channel stays referenced; losing the controller terminates this private session.
import { main } from "../continuity-benchmark.mjs";
let finished = false;
process.on("disconnect", () => {
  if (!finished) { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } }
});
process.send({ ready: true });
process.once("message", async ({ argv }) => {
  process.send({ started: true });
  let code = 1;
  try { code = await main(argv); } catch { /* Errors never expose credentials to IPC/logs. */ }
  finished = true;
  process.disconnect(); process.exit(code);
});
