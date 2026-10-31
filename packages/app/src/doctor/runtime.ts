import { describeMonoRuntimeSupport } from "@mono-agent/turn/host";
import type { RuntimeModelReference } from "@mono-agent/turn/host/types";
import {
  EFFORT_LEVELS,
} from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import { getPiBuiltinModel, listPiBuiltinProviders } from "@mono-agent/turn/ai";
import { runtimeProvenanceDetail } from "../provenance/runtime-provenance.js";
import { resolveAdvertisedModelEffort } from "../providers/model-effort-capabilities.js";
import type { ValidationSection, ValidationStatus } from "./doctor-types.js";
import { displayReferenceOf, displayReason, displayText } from "./format.js";

export async function runtimeProvenanceSection(verifiedDetail?: string): Promise<ValidationSection> {
  return {
    id: "runtime-provenance",
    label: "Runtime provenance",
    status: "ok",
    details: [verifiedDetail ?? await runtimeProvenanceDetail()],
  };
}

export function runtimeSection(config: MonoAgentConfig): ValidationSection {
  const details: string[] = [];
  let status: ValidationStatus = "ok";
  const routes = configuredRuntimeRouteChecks(config);
  for (const route of routes) {
    try {
      if (config.runtime.context1MModels?.[`${route.model.provider}:${route.model.model}`] === true) {
        details.push(`${route.label} ${displayReferenceOf(route.model)}: 1M context enabled (catalog-inferred eligibility, not a subscription guarantee).`);
      }
      const support = describeMonoRuntimeSupport(route.model);
      const resolutionIssue = piModelResolutionIssue(config, route.model);
      const effortWarning = runtimeRouteEffortWarning(config, route);
      if (resolutionIssue === undefined) {
        details.push(
          `${route.label} ${displayReferenceOf(route.model)} runs on ${support.backend.label} ` +
          `(effort: ${route.effort ?? "provider default"}).`,
        );
      } else {
        status = "error";
        details.push(`${route.label} ${displayReferenceOf(route.model)}: ${resolutionIssue}.`);
      }
      if (effortWarning !== undefined) {
        if (status !== "error") status = "waiting";
        details.push(effortWarning);
      }
    } catch (error) {
      status = "error";
      details.push(`${route.label} ${displayReferenceOf(route.model)}: ${displayReason(error)}.`);
    }
  }

  return { id: "runtime", label: "Runtime", status, details };
}

interface ConfiguredRuntimeRouteCheck {
  readonly label: string;
  readonly configPath: string;
  readonly model: RuntimeModelReference;
  readonly effort?: string;
}

export function configuredRuntimeRouteChecks(config: MonoAgentConfig): readonly ConfiguredRuntimeRouteCheck[] {
  const primary: ConfiguredRuntimeRouteCheck = {
    label: "Primary model",
    configPath: "runtime.effort",
    model: config.runtime.model,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
  };
  return [
    primary,
    ...(config.runtime.session?.continuity?.upkeep?.enabled ? [{
      label: config.runtime.session.continuity.upkeep.extractionModel ? "Continuity upkeep model" : "Continuity upkeep default representative model", configPath: "runtime.session.continuity.upkeep.extractionModel",
      model: config.runtime.session?.continuity.upkeep.extractionModel ?? config.runtime.model,
    }] : []),
    ...(config.runtime.fallbacks ?? []).map((fallback, index) => ({
      label: "Fallback model",
      configPath: `runtime.fallbacks[${index}].effort`,
      model: fallback.model,
      ...(fallback.effort === undefined ? {} : { effort: fallback.effort }),
    })),
  ];
}

function runtimeRouteEffortWarning(
  config: MonoAgentConfig,
  route: ConfiguredRuntimeRouteCheck,
): string | undefined {
  if (route.effort === undefined) return undefined;
  // Always go through the shared resolver. Deriving the ladder from
  // `thinkingLevelMap`'s KEYS treated an override table as the complete
  // supported set: claude-fable-5 maps only {off, xhigh, max}, which yielded
  // [none, xhigh, max] and made a perfectly valid `effort: medium` warn and
  // recommend xhigh. The resolver reports [minimal, low, medium, high, xhigh,
  // max] for that model, and it is the same one the catalog and pickers use --
  // doctor disagreeing with what the selector offers is its own bug.
  const resolved = resolveAdvertisedModelEffort(route.model, {
    ...(config.providers?.local === undefined ? {} : { localProviders: config.providers.local }),
  });
  // A NON-REASONING route has no advertised ladder at all, so the level-list
  // check below returns clean and `effort: high` was reported ready. Keep this
  // ahead of that check: a local model can declare `reasoning_mode: "none"`
  // WITH `reasoning_levels`, and "this route does not reason" is the accurate
  // diagnosis there, not "pick another level".
  if (resolved.reasoning === false && route.effort !== "none") {
    return `[WARN] ${route.configPath}=${route.effort} is unsupported because known model metadata marks ${displayReferenceOf(route.model)} as non-reasoning; use none, or omit it for the provider default. The runtime remains permissive and will forward the configured value.`;
  }
  const advertised = resolved.effortLevels
    ?.filter((level) => (EFFORT_LEVELS as readonly string[]).includes(level));
  if (advertised === undefined || advertised.length === 0 || advertised.includes(route.effort)) return undefined;
  const configuredIndex = EFFORT_LEVELS.indexOf(route.effort as (typeof EFFORT_LEVELS)[number]);
  const nearest = advertised.reduce((best, candidate) => {
    const candidateIndex = EFFORT_LEVELS.indexOf(candidate as (typeof EFFORT_LEVELS)[number]);
    const bestIndex = EFFORT_LEVELS.indexOf(best as (typeof EFFORT_LEVELS)[number]);
    return Math.abs(candidateIndex - configuredIndex) < Math.abs(bestIndex - configuredIndex) ? candidate : best;
  });
  return `[WARN] ${route.configPath}=${route.effort} is outside ${displayReferenceOf(route.model)}'s advertised effort levels (${advertised.join(", ")}); nearest advertised level: ${nearest}. The runtime remains permissive and will forward the configured value.`;
}

/**
 * Mirrors the Pi runtime's actual model-resolution boundary. Mono-agent only
 * registers a custom Pi provider from `providers.local`; it deliberately does
 * not import Pi CLI's ambient sibling `models.json`. Without a matching local
 * provider, `resolvePiRuntimeModel` performs an exact built-in catalog lookup.
 */
export function piModelResolutionIssue(
  config: MonoAgentConfig,
  model: RuntimeModelReference,
): string | undefined {
  const localProvider = config.providers?.local?.find((provider) => provider.id === model.provider);
  if (localProvider !== undefined) {
    if (localProvider.enabled === false) {
      return `provider \`${displayText(model.provider)}\` is disabled in providers.local`;
    }
    const localModel = localProvider.models?.find(
      (candidate) => candidate.name === model.model || candidate.alias === model.model,
    );
    if (localModel?.enabled === false) {
      return `model \`${displayText(model.model)}\` is disabled in providers.local for provider \`${displayText(model.provider)}\``;
    }
    return undefined;
  }

  // Validate against the runtime's upstream catalog facade, not pi-ai directly,
  // so a pi builtin validates through the same snapshot-cloned view the
  // runtime resolves and prices with. Unknown refs still fail with the same
  // diagnostic.
  if (
    isPiBuiltinProvider(model.provider)
    && getPiBuiltinModel(model.provider, model.model) !== undefined
  ) {
    return undefined;
  }

  // This is doctor's own validate-time diagnostic, not the runtime failure
  // string. The one that must stay byte-identical for `NON_RETRYABLE_PROVIDER_RE`
  // is built in turn's `providers/pi/models.ts`; nothing matches
  // against this text. So the reference is bounded here, which matters now that
  // the parser imposes no length ceiling and a legitimately long id reaches this
  // line whole.
  const reference = displayText(`${model.provider}:${model.model}`);
  return (
    `pi model not found: ${reference}; no matching providers.local entry exists and Pi's built-in catalog has no exact model. ` +
    "The sibling Pi CLI models.json is not a mono-agent runtime source; add providers.local for a self-hosted provider or choose a built-in Pi model"
  );
}

function isPiBuiltinProvider(provider: string): boolean {
  return listPiBuiltinProviders().some((candidate) => candidate.id === provider);
}
