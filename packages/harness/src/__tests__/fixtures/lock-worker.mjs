import { JournalLocks } from "../../journal-lock.js";
const locks = await JournalLocks.open(process.argv[2]);
const original = locks.tryLock.bind(locks);
locks.tryLock = async (path) => {
  const lock = await original(path);
  if (!lock && path.endsWith("journal-fictional.sqlite")) process.send({ phase: "blocked" });
  return lock;
};
const writer = await locks.acquireWriter("journal-fictional");
process.send({ phase: "acquired" });
process.once("message", async () => {
  await locks.releaseWriter(writer);
  process.send({ phase: "released" }); process.disconnect();
});
