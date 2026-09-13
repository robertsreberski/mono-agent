import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
// Compiled app/adapter are deliberately required, not substituted by a TS loader.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/managed-subagent-crash.mjs", import.meta.url));
it.skipIf(process.platform === "win32").each(["preparing", "attested", "release-fence", "running", "terminal", "certificate-before-write", "certificate-lost-ack", "certificate-after-copy", "certificate-after-ack"])(
  "physically kills managed %s owner and reopens twice without replay or duplicate wake",
  async (scenario) => {
    const { stdout } = await execute(process.execPath, [fixture, scenario], { cwd: root, timeout: 90_000, maxBuffer: 32_768 });
    expect(JSON.parse(stdout.trim())).toMatchObject({ kind: "managed-physical-crash-proof", scenario, reopens: 2, result: "passed" });
  },
  95_000,
);
