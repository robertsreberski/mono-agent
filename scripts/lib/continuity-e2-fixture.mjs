// The sole E2 proof subprocess entry. No configurable executable, module or command.
import { realpath, lstat, readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute, relative } from "node:path";
import { ROOT, fail } from "./continuity-observation-input.mjs";
import { runProofPhase } from "./continuity-e2-proofs.mjs";
import { PROOF_CODES } from "./continuity-e2-checks.mjs";
import { proofEnvironment, installProofIsolation } from "./continuity-e2-isolation.mjs";
import { privateModes } from "./continuity-e2-replay.mjs";
import { errorDiagnostic } from "./continuity-e2-diagnostics.mjs";
const [phase, base, ...extra] = process.argv.slice(2);
let restore;
try {
  if (extra.length || !["seed", "resume"].includes(phase) || !isAbsolute(base ?? "") || await realpath(base) !== base || !relative(ROOT, base).startsWith("..")) fail("E2_ARGUMENTS_INVALID");
  const stat = await lstat(base);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) fail("E2_ARGUMENTS_INVALID");
  const config = JSON.parse(await readFile(join(base, "fixture.json"), "utf8"));
  if (!["cancel", "pressure"].includes(config.arm) || !["ceiling", "restart"].includes(config.variant) || Object.keys(config).some(k => !["arm", "variant", "fault", "summary"].includes(k))) fail("E2_ARGUMENTS_INVALID");
  restore = installProofIsolation(await proofEnvironment(join(base, "hermetic")));
  const result = await runProofPhase({ ...config, phase, base });
  await privateModes(base);
  await writeFile(join(base, `${phase}.json`), `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
} catch (error) {
  // Fixed diagnostics only; no child stdout/stderr or arbitrary exception text.

  if (restore) await writeFile(join(base, `${phase}-refusal.json`), JSON.stringify({ code: PROOF_CODES.includes(error?.code) ? error.code : "E2_PROOF_FIXTURE_FAILED", diagnostic: errorDiagnostic(error) }), { flag: "wx", mode: 0o600 });
  process.exitCode = 1;
} finally { restore?.(); }
