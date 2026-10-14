// Stop a real writer inside writeFile, before its file sync. The parent kills it.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const [root, owner, kind, written] = process.argv.slice(2);
const originalOpen = fs.open;
fs.open = async (...args) => {
  const handle = await originalOpen(...args), path = String(args[0]);
  if (path.endsWith(kind === "active" ? ".active" : ".dirty.tmp")) {
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (bytes) => {
      await write(Buffer.from(bytes).subarray(0, Number(written)));
      process.send({ path });
      await new Promise(() => { setInterval(() => {}, 60_000); });
    };
  }
  return handle;
};
syncBuiltinESMExports();
const { createDurableHistoryStore } = await import("../../../dist/durable-history.js");
await createDurableHistoryStore({ root }).beginProviderSessionTurn(owner, "fictional-interrupted-write", { modelKey: "openai:fictional-model" });
throw new Error("Writer did not reach the requested coordination barrier");
