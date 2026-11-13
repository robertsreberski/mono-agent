import { createRequire } from "node:module";

// This file is an isolated process entry, not imported by the collector.
async function probe(): Promise<Readonly<Record<string, unknown>>> {
  switch (process.argv[2]) {
    case "memory": {
      const { openMemoryDb } = await import("@mono-agent/memory/store");
      const db = openMemoryDb({ path: ":memory:" });
      try { db.indexMetadata(); return { betterSqlite3: "loaded", sqliteVec: "loaded", vecVersion: db.vecVersion() }; }
      finally { db.close(); }
    }
    case "sharp": {
      const require = createRequire(import.meta.url);
      // Resolve, do not import turn's heavyweight entry. Resolve sharp from its owner.
      const turnRequire = createRequire(require.resolve("@mono-agent/turn"));
      const sharp = turnRequire("sharp") as (input: { create: { width: number; height: number; channels: number; background: string } }) => { png(): { toBuffer(): Promise<Buffer> } };
      const output = await sharp({ create: { width: 1, height: 1, channels: 3, background: "black" } }).png().toBuffer();
      return { sharp: "loaded", outputBytes: output.length };
    }
    case "sandbox": {
      const { sandboxRuntimeStatus } = await import("../service/sandbox/sandbox-manager.js");
      const { MANAGED_SRT_VERSION } = await import("@mono-agent/turn/host/sandbox");
      const abort = new AbortController();
      const cancel = (): void => abort.abort();
      process.once("SIGTERM", cancel);
      let status;
      try { status = await sandboxRuntimeStatus({ signal: abort.signal }); }
      finally { process.removeListener("SIGTERM", cancel); }
      return { state: status.state, source: status.source, version: MANAGED_SRT_VERSION };
    }
    default: throw new Error("Unknown host probe");
  }
}
probe().then((observed) => process.stdout.write(`${JSON.stringify({ ok: true, observed })}\n`)).catch((error: unknown) => {
  // Native diagnostics can contain paths. Keep only a bounded classification input;
  // the parent exposes structured facts, never raw stacks or environment values.
  const e = error as { code?: string; message?: string };
  process.stdout.write(`${JSON.stringify({ ok: false, error: `${e.code ?? ""} ${e.message ?? "Probe failed"}`.slice(0, 4096) })}\n`);
  process.exitCode = 1;
});
