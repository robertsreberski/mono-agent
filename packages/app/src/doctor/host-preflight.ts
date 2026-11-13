import { readFileSync } from "node:fs";
import { minimumNode, requiredNode, supportedNode } from "../node-version-guard.js";
import { DEFAULT_WEB_PORT } from "../service/web/web-service-definition.js";
import { bindLoopback, boundedProcess, isolatedProbe, loopbackProbe, toolAvailable } from "./host-preflight-probes.js";
import { nativeRemediations } from "./host-remediation.js";
import { classifyNativeFailure } from "./native-failures.js";
import type { HostCheck, HostCheckId, HostPreflightReport, HostRemediation } from "./host-preflight-types.js";

export function hostReport(checks: readonly HostCheck[], failure?: HostPreflightReport["failure"]): HostPreflightReport {
  return { schemaVersion: 1, operation: "host-preflight", ok: failure === undefined && !checks.some((c) => c.status === "error"),
    runtime: { nodeVersion: process.versions.node, requiredNode, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch },
    checks, ...(failure === undefined ? {} : { failure }) };
}
function check(id: HostCheckId, status: HostCheck["status"], code: string, message: string, observed: HostCheck["observed"] = {}, remediations: readonly HostRemediation[] = []): HostCheck {
  return { id, status, code, message, observed, remediations };
}
export async function nativeCheck(kind: "memory" | "sharp", probe = isolatedProbe): Promise<HostCheck> {
  const result = await probe(kind);
  if (result.ok) return check(`native.${kind}`, "ok", "native_load_ok", kind === "memory" ? "better-sqlite3 and sqlite-vec loaded and queried in memory." : "sharp loaded and encoded a tiny image.", result.observed);
  const classification = result.error ? classifyNativeFailure(result.error) : { code: result.code };
  return check(`native.${kind}`, "error", classification.code, `Isolated ${kind} probe failed; select supported Node and rebuild/reinstall this installation.`,
    { runningAbi: process.versions.modules, ...classification }, nativeRemediations());
}
export async function serviceCheck(platform = process.platform, run = boundedProcess): Promise<HostCheck> {
  const result = platform === "darwin"
    ? await run("/bin/launchctl", ["print", `gui/${process.getuid?.() ?? -1}`])
    : platform === "linux" ? await run("systemctl", ["--user", "show", "--property=Version", "--value"]) : undefined;
  return check("service.manager", result?.ok ? "ok" : "warning", result?.ok ? "service_manager_ready" : "service_manager_unavailable",
    result?.ok ? "User service manager is reachable." : "User service manager is unavailable; foreground operation remains supported.",
    { manager: platform === "darwin" ? "launchd" : platform === "linux" ? "systemd-user" : "unsupported" }, result?.ok ? [] : [
      { command: "mono-agent start --foreground", explanation: "Alternative: run the agent without a service manager.", prerequisite: "After scaffolding and validating an agent folder; keep this terminal open." },
      { command: "mono-agent web run --loopback", explanation: "Alternative: run a foreground console after scaffolding." },
    ]);
}
export async function modelsCheck(kind: "ollama" | "lmstudio", request = loopbackProbe, available = toolAvailable): Promise<HostCheck> {
  const ollama = kind === "ollama";
  const port = ollama ? 11434 : 1234;
  const result = await request(port, ollama ? "/api/tags" : "/v1/models");
  const cliAvailable = await available(ollama ? "ollama" : "lms");
  return check(`models.${kind}`, result.ok ? "ok" : "info", result.ok ? "models_reachable" : result.code,
    result.ok ? `${kind} loopback model-list endpoint is reachable (no inference performed).` : `${kind} is not reachable at its default loopback endpoint; this capability is optional.`,
    { host: "127.0.0.1", port, cliAvailable }, result.ok ? [] : [
      { command: ollama ? "ollama serve" : "lms server start --port 1234", explanation: `Optional: start ${kind} if installed. No model download or inference is requested.`, prerequisite: cliAvailable ? "Run only if this local model server is wanted." : `Install the CLI first: ${ollama ? "https://ollama.com/download" : "https://lmstudio.ai/download"} (choose your platform).` },
    ]);
}
export async function sandboxCheck(platform = process.platform, probe = isolatedProbe, available = toolAvailable): Promise<HostCheck> {
  const result = await probe("sandbox");
  const ready = result.ok && result.observed.state === "ready";
  // The shipped integrity-locked input is authoritative even if status crashes.
  const resource = JSON.parse(readFileSync(new URL("../../resources/srt/package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  const version = resource.dependencies["@anthropic-ai/sandbox-runtime"]!;
  const remedies: HostRemediation[] = [];
  const tools: Record<string, boolean> = {};
  if (!ready) {
    if (platform === "darwin") remedies.push({ command: "mono-agent sandbox setup", explanation: "Optional: install/repair the pinned user-cache sandbox; no global installation." });
    else if (platform === "linux") {
      const results = await Promise.all(["bwrap", "socat"].map(available));
      tools.bwrap = results[0]!;
      tools.socat = results[1]!;
      remedies.push({ command: `npm install --global @anthropic-ai/sandbox-runtime@${version}`, explanation: "Optional: install the repository-pinned external SRT, then rerun mono-agent preflight.", prerequisite: "Requires bubblewrap (bwrap), socat, and enabled unprivileged user namespaces. Install missing prerequisites using your distribution's package manager; global npm may require an administrator-owned prefix." });
    } else remedies.push({ command: "mono-agent preflight", explanation: "Run on a supported macOS host, or Linux/WSL with external SRT and its platform prerequisites installed.", prerequisite: "This command checks only; it cannot repair an unsupported host or a crashed sandbox probe." });
  }
  return check("sandbox.runtime", ready ? "ok" : "warning", ready ? "sandbox_ready" : result.ok ? `sandbox_${String(result.observed.state)}` : result.code,
    ready ? "Sandbox runtime passed the existing status checks." : "Sandbox is unavailable or could not be verified; sandboxed execution is optional.", { ...result.observed, prerequisites: tools }, remedies);
}
export async function consolePortCheck(port: number): Promise<HostCheck> {
  const result = await bindLoopback(port);
  const alternative = result.ok ? undefined : await bindLoopback(0);
  return check("console.port", result.ok ? "ok" : "warning", result.ok ? "port_available" : "port_unavailable",
    result.ok ? "Console loopback port is available (snapshot only)." : "Console port cannot be bound; an existing console or another listener may own it.",
    { host: "127.0.0.1", port, ...(alternative?.ok ? { suggestedPort: alternative.port } : {}) }, result.ok ? [] : [
      { command: `mono-agent web run --loopback --port ${alternative?.ok ? alternative.port : 5051}`, explanation: alternative?.ok ? "Use an observed-free port after scaffolding; it is not reserved." : "Try another port after scaffolding; availability could not be confirmed." },
    ]);
}
export async function collectHostPreflight(port = DEFAULT_WEB_PORT): Promise<HostPreflightReport> {
  const checks = await Promise.all([nativeCheck("memory"), nativeCheck("sharp"), serviceCheck(), modelsCheck("ollama"), modelsCheck("lmstudio"), sandboxCheck(), consolePortCheck(port)]);
  const nodeOk = supportedNode(process.versions.node);
  return hostReport([
    check("runtime.node", nodeOk ? "ok" : "error", nodeOk ? "node_supported" : "node_unsupported", `Node ${process.versions.node}; required ${requiredNode}.`, {}, nodeOk ? [] : [
      { command: `nvm install ${minimumNode} && nvm use ${minimumNode}`, explanation: "Select supported Node before rebuilding native dependencies." },
    ]),
    check("runtime.node-abi", "ok", "node_abi_observed", `Running Node ABI ${process.versions.modules}; native load checks determine compatibility.`, { nodeAbi: process.versions.modules }),
    ...checks,
  ]);
}
