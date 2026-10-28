// Leave a genuinely hot DELETE-mode journal in a synthetic store after SIGKILL.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE;");
db.exec("UPDATE continuity_ledger SET payload=zeroblob(262144); CREATE TABLE synthetic_spill(value BLOB);");
const insert = db.prepare("INSERT INTO synthetic_spill VALUES (zeroblob(8192))");
for (let i = 0; i < 128; i++) insert.run();
process.send({ ready: true });
setInterval(() => {}, 1000);
