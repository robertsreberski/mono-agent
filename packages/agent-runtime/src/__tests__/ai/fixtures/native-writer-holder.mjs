// Holds one durable native session's writer lock from another process until killed.
import { JsonlSessionRepo } from "../../../../../engine/dist/session-store.js";
const [root, sessionId] = process.argv.slice(2);
const repo = new JsonlSessionRepo({ sessionsRoot: root });
const metadata = (await repo.listOwned()).find((entry) => entry.id === sessionId);
await repo.open(metadata, { repair: false, wait: false });
process.send?.({ held: true });
process.on("disconnect", () => process.exit(0)); // never outlive the test process
setInterval(() => {}, 1_000);
