import { modelReferenceKey, parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";
import { describePiProviderAuth } from "@mono-agent/turn/ai";

import { PI_API_KEY_PROVIDERS } from "./credential-values.js";
import { DEFAULT_PI_AUTH_PATH, piAuthPathForSetup, piAuthRecoveryCommand, piAuthWorkingDirectory, piLoginCommand, shellQuote } from "./oauth-command.js";
import type {
  PlanProviderSetupOptions,
  ProviderSetupAction,
  ProviderSetupPiApiKeyAction,
  ProviderSetupPiLoginAction,
  ProviderSetupPlan,
} from "./setup-types.js";

export function planProviderSetup(options: PlanProviderSetupOptions): ProviderSetupPlan {
  const piAuthPath = options.piAuthPath ?? DEFAULT_PI_AUTH_PATH;
  const actionsById = new Map<string, ProviderSetupAction>();
  const detectedModelRefs = new Set<string>();
  const authAlreadyDetected = (keys: readonly string[]): boolean =>
    options.forceAuthentication !== true && keys.some((key) => {
      const state = options.credentialStates?.[key];
      return state === "credential_detected" || state === "verified";
    });

  for (const raw of options.modelRefs) {
    let ref;
    try {
      ref = parseMonoRuntimeModelReference(raw);
    } catch {
      continue;
    }

    const refKey = modelReferenceKey(ref);
    const add = (action: ProviderSetupAction) => {
      const existing = actionsById.get(action.id);
      if (existing === undefined) {
        actionsById.set(action.id, action);
        return;
      }
      actionsById.set(action.id, {
        ...existing,
        modelRefs: [...new Set([...existing.modelRefs, ...action.modelRefs])],
      } as ProviderSetupAction);
    };

    if (authAlreadyDetected([ref.provider, refKey])) {
      detectedModelRefs.add(refKey);
      continue;
    }

    if (ref.provider === "ollama") {
      add({
        id: "ollama-list",
        kind: "preflight",
        label: "Ollama model preflight",
        modelRefs: [refKey],
        command: ["ollama", "list"],
        cwd: options.cwd,
        detail: "Checks that the local Ollama server and CLI can list installed models.",
      });
      continue;
    }

    if (ref.provider === "lmstudio") {
      add({
        id: "lmstudio-models",
        kind: "preflight",
        label: "LM Studio model preflight",
        modelRefs: [refKey],
        url: "http://localhost:1234/v1/models",
        cwd: options.cwd,
        detail: "Checks that LM Studio's OpenAI-compatible local server exposes models.",
      });
      continue;
    }

    const provider = describePiProviderAuth(ref.provider);
    const supportsOAuth = provider?.methods.some((method) => method.type === "oauth") === true;
    const apiKeyMethod = provider?.methods.find((method) => method.type === "api_key");
    const supportsApiKeyLogin = apiKeyMethod?.interactive === true;
    const selectedMethod = options.piAuthMethods?.[ref.provider]
      ?? (ref.provider === "openai" ? undefined : supportsOAuth ? "oauth" : supportsApiKeyLogin ? "api-key" : undefined);

    if (selectedMethod === "api-key" && supportsApiKeyLogin) {
      const envVar = PI_API_KEY_PROVIDERS[ref.provider];
      // Complex or ambient providers may require multiple values. Never invent
      // an environment name or persist an incomplete credential; their normal
      // provider environment remains available as the explicit manual path.
      if (envVar === undefined) continue;
      const persistence = options.piApiKeyPersistenceByProvider?.[ref.provider]
        ?? options.piApiKeyPersistence
        ?? "secure-store";
      add({
        id: `pi-api-key:${ref.provider}`,
        kind: "auth",
        label: `${apiKeyMethod?.label ?? ref.provider} (${persistence === "secure-store" ? "secure store" : "environment"})`,
        modelRefs: [refKey],
        provider: ref.provider,
        envVar,
        persistence,
        piAuthPath: piAuthPathForSetup(piAuthPath, options.cwd),
        cwd: piAuthWorkingDirectory(piAuthPath, options.cwd),
        detail: persistence === "secure-store"
          ? `Stores ${envVar} in the owner-only Pi auth store used by providers.piAuthPath.`
          : `Uses ${envVar} from the durable agent environment without copying it into Pi auth.json.`,
      });
      continue;
    }

    if (selectedMethod !== "oauth" || !supportsOAuth) {
      continue;
    }

    add({
      id: `pi-login:${ref.provider}`,
      kind: "auth",
      label: `Pi login for ${ref.provider}`,
      modelRefs: [refKey],
      command: piLoginCommand(ref.provider, options.piCliPath, piAuthPathForSetup(piAuthPath, options.cwd)),
      piAuthPath: piAuthPathForSetup(piAuthPath, options.cwd),
      cwd: piAuthWorkingDirectory(piAuthPath, options.cwd),
      detail: `Runs bundled Pi auth for provider \`${ref.provider}\` and securely replaces providers.piAuthPath.`,
    });
  }

  return { actions: [...actionsById.values()], detectedModelRefs: [...detectedModelRefs] };
}

export function providerSetupActionCommandLine(action: ProviderSetupAction): string {
  if ("command" in action) {
    if (isProviderSetupPiLoginAction(action)) {
      return piAuthRecoveryCommand(action.id.slice("pi-login:".length), action.piAuthPath);
    }
    return action.command.map(shellQuote).join(" ");
  }
  if (isProviderSetupPiApiKeyAction(action)) {
    return `${action.envVar} -> ${action.piAuthPath}`;
  }
  return `GET ${action.url}`;
}

export function isProviderSetupPiApiKeyAction(action: ProviderSetupAction): action is ProviderSetupPiApiKeyAction {
  return "provider" in action && "piAuthPath" in action && "envVar" in action;
}

export function isProviderSetupPiLoginAction(action: ProviderSetupAction): action is ProviderSetupPiLoginAction {
  return action.id.startsWith("pi-login:") && "piAuthPath" in action && "command" in action;
}
