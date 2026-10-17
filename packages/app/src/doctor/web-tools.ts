import { inspectLocalWeb, inspectParallelWeb } from "@mono-agent/turn/tools";
import { inspectWebControl } from "../web-request-coordinator.js";
import { inspectCodexSubscriptionSearch } from "@mono-agent/turn/tools";
import { networkPolicyAllowsUrl } from "@mono-agent/turn/host/sandbox";
import type { MonoAgentConfig } from "@mono-agent/config";
import { normalizeOptionalString } from "@mono-agent/contracts";
import type { ValidationSection, ValidationStatus } from "../doctor-types.js";
import type { ValidateMonoAgentFolderOptions } from "./options.js";
import { LIVENESS_PROBE_TIMEOUT_MS, OLLAMA_WEB_SEARCH_PROBE_MAX_BYTES, defaultDoctorStatusExecFile, DOCTOR_STATUS_TIMEOUT_MS, DOCTOR_STATUS_MAX_BUFFER_BYTES } from "./probe-defaults.js";

const MIN_AGENT_BROWSER_VERSION = [0, 33, 1] as const;

export async function webToolsSection(
  config: MonoAgentConfig,
  input: ValidateMonoAgentFolderOptions,
  liveness: boolean,
): Promise<ValidationSection> {
  const web = config.tools.web;
  const search: NonNullable<MonoAgentConfig["tools"]["web"]>["search"] = web?.search ?? {
    backend: ["parallel", "ollama"] as const,
    maxRequestsPerRun: 4,
    codex: { model: "gpt-5.6-luna" },
  };
  const fetchConfig = web?.fetch ?? { render: "never" as const, browserCommand: "agent-browser" };
  const details = [
    `WebSearch backend: ${search.backend}.`,
    `WebSearch request budget: ${search.maxRequestsPerRun ?? 4} per logical run.`,
    `Web coordination: ${web?.coordination ?? "process"}.`,
  ];
  let status: ValidationStatus = "ok";
  if (web?.coordination === "host") {
    try {
      const shared = await inspectWebControl();
      details.push(shared.exists ? "Host web control state is valid." : "Host web control state will be initialized on first request.");
    } catch {
      status = "waiting";
      details.push("Host web control state is unavailable; web requests will fail closed. Inspect with mono-agent web-control status.");
    }
  }

  const searxngEndpoint = search.searxng?.endpoint ?? search.endpoint;
  const chain = typeof search.backend === "string" ? [search.backend] : search.backend;
  const chained = typeof search.backend !== "string";
  const fallback = chained ? `Ordered chain: ${chain.join(" → ")}. Unavailable providers advance to the next entry.` : "Strict provider selection has no fallback.";
  details.push(fallback);
  if (searxngEndpoint === undefined) {
    details.push("SearXNG is not configured.");
  } else {
    details.push(`SearXNG endpoint: ${searxngEndpoint}.`);
    if (!liveness) {
      details.push("SearXNG liveness was not probed.");
    } else {
      const probe = await probeSearxngEndpoint(searxngEndpoint);
      if (probe.ok) {
        details.push("SearXNG JSON search probe succeeded.");
      } else {
        status = "waiting";
        details.push(
          `[WARN] SearXNG JSON search probe failed (${probe.reason}). ` +
          (chained
            ? `Start the local companion or fix tools.web.search.searxng.endpoint. ${fallback}`
            : "Start the local companion or fix tools.web.search.searxng.endpoint; strict SearXNG mode has no fallback."),
        );
      }
    }
  }

  if (chain.includes("ollama")) {
    const ollama = search.ollama;
    if (ollama === undefined) {
      status = "waiting";
      details.push("[WARN] Ollama Web Search is selected but its resolved configuration is missing.");
    } else if (!liveness || chained) {
      details.push(`Ollama Web Search origin: ${ollama.baseUrl}. ${search.backend === "ollama" ? "Strict Ollama mode has no fallback." : fallback}`);
      details.push(chained ? "Ollama Web Search readiness is checked lazily when the chain reaches it." : "Ollama Web Search liveness was not probed.");
    } else {
      details.push(`Ollama Web Search origin: ${ollama.baseUrl}. ${search.backend === "ollama" ? "Strict Ollama mode has no fallback." : fallback}`);
      const probe = await probeOllamaWebSearch(ollama, input.env);
      if (probe.ok) details.push("Ollama Web Search JSON probe succeeded.");
      else {
        status = "waiting";
        details.push(`[WARN] Ollama Web Search probe failed (${probe.reason}). ${search.backend === "ollama" ? "Strict Ollama mode has no fallback." : fallback}`);
      }
    }
  } else if (search.ollama !== undefined) {
    details.push(`Ollama Web Search is configured but inactive because backend ${search.backend} is strict.`);
  }

  if (chained && chain.includes("codex")) {
    details.push(`Codex subscription fallback model: ${search.codex?.model ?? "gpt-5.6-luna"}; readiness is checked lazily when the chain reaches it.`);
  } else if (search.backend === "codex") {
    const codexModel = search.codex?.model ?? "gpt-5.6-luna";
    details.push(`Codex subscription search model: ${codexModel}.`);
    if (!liveness) {
      details.push("Codex subscription search readiness was not probed.");
    } else {
      const probe = await (input.codexWebSearchProbe ?? inspectCodexSubscriptionSearch)({ model: codexModel });
      if (probe.ok) {
        details.push("Codex ChatGPT subscription, web-search capability, and configured model are ready.");
      } else {
        status = "waiting";
        details.push(
          `[WARN] Codex subscription search is not ready (${probe.reason}). `
          + "Strict Codex mode has no fallback.",
        );
      }
    }
  }

  const fetchProviders = typeof fetchConfig.provider === "string" ? [fetchConfig.provider] : fetchConfig.provider ?? ["local"];
  if (chain.includes("parallel") || fetchProviders.includes("parallel")) {
    const parallelConfigs = [
      ...(chain.includes("parallel") ? [{ label: "search", settings: search.parallel, strict: !chained }] : []),
      ...(fetchProviders.includes("parallel") ? [{ label: "fetch", settings: fetchConfig.parallel, strict: fetchProviders.length === 1 }] : []),
    ];
    for (const entry of parallelConfigs) {
      details.push(`Parallel ${entry.label}: ${entry.settings?.apiKeyEnv ? "apiKeyEnv configured" : "anonymous access"}.`);
      if (!liveness || !entry.strict) {
        details.push(`Parallel ${entry.label} tools/list was not probed; readiness is checked on use.`);
      } else {
        const probe = await inspectParallelWeb({ config: entry.settings,
          sandbox: { networkAllowsUrl: networkPolicyAllowsUrl }, policy: config.sandbox });
        if (!probe.ok) status = "waiting";
        details.push(probe.ok ? "Parallel tools/list advertises web_search and web_fetch (extraction not exercised)."
          : `[WARN] Parallel tools/list unavailable (${probe.reason}).`);
      }
    }
  }

  details.push(`WebFetch provider: ${JSON.stringify(fetchConfig.provider ?? "local")}.`);
  if (chain.includes("local") || fetchProviders.includes("local")) {
    const probe = await inspectLocalWeb();
    if (!probe.ok) status = "waiting";
    details.push("Local is a built-in Node provider; no endpoint or Python service is required.");
    details.push(probe.ok ? "Local web capability is available (public engines and extraction not probed)." : "[WARN] Local web capability is unavailable.");
  }

  details.push(`WebFetch browser rendering: ${fetchConfig.render}.`);
  if (fetchConfig.render === "never") {
    details.push("Static Defuddle/Readability extraction is active; agent-browser is not required.");
  } else if (!liveness) {
    details.push(`agent-browser liveness was not probed (${fetchConfig.browserCommand}).`);
  } else {
    const version = await readAgentBrowserVersion(fetchConfig.browserCommand, input);
    if (version === null || compareVersion(version, MIN_AGENT_BROWSER_VERSION) < 0) {
      status = "waiting";
      const found = version === null ? "missing or unreadable" : `v${version.join(".")}`;
      details.push(
        `[WARN] agent-browser is ${found}; WebFetch auto rendering requires >=${MIN_AGENT_BROWSER_VERSION.join(".")}.`,
      );
    } else {
      details.push(`agent-browser v${version.join(".")} is ready.`);
    }
  }

  return { id: "web-tools", label: "Web search & fetch", status, details };
}

async function probeOllamaWebSearch(
  config: NonNullable<NonNullable<MonoAgentConfig["tools"]["web"]>["search"]["ollama"]>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly ok: boolean; readonly reason: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, LIVENESS_PROBE_TIMEOUT_MS);
  const official = config.baseUrl === "https://ollama.com";
  // Resolve-at-use like every other consumer: the loader carries only the name.
  const apiKey = config.apiKeyEnv === undefined
    ? config.apiKey
    : normalizeOptionalString(env[config.apiKeyEnv]) ?? config.apiKey;
  const paths = official ? ["/api/web_search"] : ["/api/experimental/web_search", "/api/web_search"];
  try {
    for (let index = 0; index < paths.length; index += 1) {
      const response = await fetch(`${config.baseUrl}${paths[index]}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(official ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ query: "mono-agent doctor", max_results: 1 }),
        redirect: "error",
        signal: ctrl.signal,
      });
      if (!official && index === 0 && [404, 405].includes(response.status)) {
        await response.body?.cancel();
        continue;
      }
      if ([401, 403].includes(response.status)) {
        await response.body?.cancel();
        return { ok: false, reason: official
          ? `hosted authentication failed; check ${config.apiKeyEnv}`
          : "the local proxy requires sign-in; run ollama signin or repair its proxy authentication" };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, reason: `HTTP ${response.status}` };
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > OLLAMA_WEB_SEARCH_PROBE_MAX_BYTES) {
        await response.body?.cancel();
        return { ok: false, reason: `response exceeded ${OLLAMA_WEB_SEARCH_PROBE_MAX_BYTES} bytes` };
      }
      const bytes = await readBoundedProbeResponse(response, OLLAMA_WEB_SEARCH_PROBE_MAX_BYTES);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { return { ok: false, reason: "response was not valid JSON" }; }
      if (!body || typeof body !== "object" || !Array.isArray((body as { results?: unknown }).results)) {
        return { ok: false, reason: "response did not contain a results array" };
      }
      return { ok: true, reason: "" };
    }
    return { ok: false, reason: "this Ollama version supports neither local Web Search endpoint" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedProbeResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("response body could not be read safely");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function probeSearxngEndpoint(endpoint: string): Promise<{ readonly ok: boolean; readonly reason: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, LIVENESS_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/u, "")}/search`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ q: "mono-agent doctor", format: "json", categories: "general" }),
      redirect: "error",
      signal: ctrl.signal,
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const body = await response.json() as {
      readonly results?: unknown;
      readonly unresponsive_engines?: unknown;
    };
    if (!Array.isArray(body.results)) {
      return { ok: false, reason: "response did not contain a results array" };
    }
    // An instance whose engines are all captcha'd or suspended answers 200 with
    // an empty result list, which the array check alone reported as healthy. The
    // empty array is not the signal on its own — this probe's query can
    // legitimately match very little — so only flag it alongside failed engines.
    const unresponsive = Array.isArray(body.unresponsive_engines) ? body.unresponsive_engines : [];
    if (body.results.length === 0 && unresponsive.length > 0) {
      const detail = unresponsive
        .map((entry) => (Array.isArray(entry) ? `${String(entry[0])}: ${String(entry[1])}` : String(entry)))
        .join("; ");
      return { ok: false, reason: `no results, and ${unresponsive.length === 1 ? "1 engine" : `${unresponsive.length} engines`} unresponsive — ${detail}` };
    }
    return { ok: true, reason: "" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function readAgentBrowserVersion(
  command: string,
  input: ValidateMonoAgentFolderOptions,
): Promise<readonly [number, number, number] | null> {
  const run = input.statusExecFile ?? defaultDoctorStatusExecFile;
  try {
    const { stdout } = await run(command, ["--version"], {
      cwd: input.cwd,
      env: Object.fromEntries(
        ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TMPDIR", "TMP", "TEMP"]
          .flatMap((key) => typeof input.env[key] === "string" ? [[key, input.env[key]]] : []),
      ),
      timeout: DOCTOR_STATUS_TIMEOUT_MS,
      maxBuffer: DOCTOR_STATUS_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(stdout.trim());
    if (match === null) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  } catch {
    return null;
  }
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! - right[index]!;
  }
  return 0;
}
