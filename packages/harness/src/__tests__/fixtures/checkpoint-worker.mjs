import { JsonlSessionRepo } from "../../session-store.js";
import { buildHarnessSessionContext } from "../../session-context.js";
const repo = new JsonlSessionRepo({ sessionsRoot: process.argv[2] });
const session = await repo.open((await repo.list())[0]);
const entries = await session.getEntries();
process.send({ messages: buildHarnessSessionContext(entries, { repairs: await session.getRepairEntries() }), checkpoint: entries.at(-1).checkpoint });
await session.close(); process.disconnect();
