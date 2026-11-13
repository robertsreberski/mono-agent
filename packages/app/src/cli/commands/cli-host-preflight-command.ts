import { HOST_PREFLIGHT_HELP, parseHostPreflightArgs, type HostPreflightArgs } from "../host-preflight-args.js";
import { collectHostPreflight, hostReport } from "../../doctor/host-preflight.js";
import type { HostPreflightReport } from "../../doctor/host-preflight-types.js";

export function renderHostPreflight(report: HostPreflightReport): string {
  const lines = [`Host preflight: ${report.ok ? "no errors" : "failed"} (Node ${report.runtime.nodeVersion}, required ${report.runtime.requiredNode}, ABI ${report.runtime.nodeAbi})`];
  if (report.failure) lines.push(report.failure.message);
  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.id}: ${check.message}`);
    for (const remedy of check.remediations) {
      lines.push(`  ${remedy.explanation}`, `  $ ${remedy.command}`);
      if (remedy.prerequisite) lines.push(`  Prerequisite: ${remedy.prerequisite}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
export async function runHostPreflight(argv: readonly string[]): Promise<number> {
  let args: HostPreflightArgs;
  try { args = parseHostPreflightArgs(argv); }
  catch {
    const report = hostReport([], { code: "usage", message: "Invalid preflight arguments. Use mono-agent preflight [--json] [--port <1-65535>]." });
    process.stdout.write(argv.includes("--json") ? `${JSON.stringify(report)}\n` : renderHostPreflight(report));
    return 2;
  }
  if (args.help) { process.stdout.write(HOST_PREFLIGHT_HELP); return 0; }
  let report: HostPreflightReport;
  try { report = await collectHostPreflight(args.port); }
  catch { report = hostReport([], { code: "preflight_failed", message: "Host preflight could not complete. Retry mono-agent preflight; check installation permissions and rebuild/reinstall under supported Node if it persists." }); }
  process.stdout.write(args.json ? `${JSON.stringify(report)}\n` : renderHostPreflight(report));
  return report.ok ? 0 : 1;
}
