import type { AgentSummary, CatalogModel } from "../../types";
import { effortName, findCatalogModel } from "../model-catalog";

/** Use advertised names without erasing the canonical id shown alongside config. */
export function settingsModelName(agent: AgentSummary, reference: string | undefined, catalog: Readonly<Record<string, readonly CatalogModel[]>>): string {
  if (!reference) return "Provider default";
  return agent.modelOptions?.[reference]?.label?.trim()
    || findCatalogModel(catalog, reference)?.name
    || reference;
}

export function settingsEffortName(effort: string | undefined): string {
  return effort ? effortName(effort) : "Provider default";
}
