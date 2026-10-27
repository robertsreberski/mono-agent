import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
const exec = promisify(execFile);
it.each(["parked", "warnings"])("checks the real writer RPC boundary and secure cleanup (%s)", async mode => {
  const fixture = await mkdtemp(join(tmpdir(), "accounting-worker-fixture-"));
  try {
    await cp(fileURLToPath(new URL("../../dist", import.meta.url)), join(fixture, "dist"), { recursive: true });
    await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(fixture, "node_modules"), "dir");
    await writeFile(join(fixture, "package.json"), '{"type":"module"}');
    if (mode === "parked") {
      const path = join(fixture, "dist/tool-history/writer-worker.js"), source = await readFile(path, "utf8");
      const needle = "write: operation => transaction(database, operation)";
      expect(source).toContain(needle);
      await writeFile(path, source.replace(needle, `write: operation => transaction(database, () => {
        const info = lstatSync(journalPath);
        if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) throw new Error("insecure export journal");
        const result = operation(); respond(0, { testSecureWrite: true }); return result;
      }), exporter: async () => {
        respond(0, { testExporterParked: true }); await new Promise(() => {}); return "exported";
      }`));
    }
    const result = await exec(process.execPath, [fileURLToPath(new URL("./fixtures/upkeep-accounting-worker-child.mjs", import.meta.url)), pathToFileURL(join(fixture, "dist/tool-history/writer.js")).href, join(fixture, "history"), mode], { timeout: 15000 });
    expect(JSON.parse(result.stdout)).toMatchObject(mode === "parked" ? { dispatch: true, outcome: true, ownerReleased: true, secureWrites: true } : { warnings: 1, namespaceRows: 0, reopenWarnings: 0 });
  } finally { await rm(fixture, { recursive: true, force: true }); }
}, 20000);
