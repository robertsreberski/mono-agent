import type { ModelSelectorOption } from "./ModelSelector";

/** Fictional catalog shared by visual stories and layout regressions. */
export const selectorEfforts = [
  { id: "", name: "Default · High" },
  { id: "minimal", name: "Minimal" },
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra high" },
  { id: "max", name: "Max" },
];
const providers = ["Atlas", "Grove", "Harbor", "Juniper", "Lumen", "Meadow", "Summit"];
export const selectorModels: readonly ModelSelectorOption[] = [
  { id: "", name: "Default · Atlas Standard", description: "Follow agent default · atlas:standard", efforts: selectorEfforts,
    supportsContext1M: true as const, standardContextWindow: 272_000 },
  ...providers.flatMap((label) => ["Standard", "Fast", "Pro", "Compact"].map((name) => ({
    id: `${label.toLowerCase()}:${name.toLowerCase()}`, name: `${label} ${name}`,
    description: `${label.toLowerCase()}:${name.toLowerCase()}`, provider: label.toLowerCase(), providerLabel: label,
    efforts: selectorEfforts, supportsContext1M: true as const, standardContextWindow: 272_000,
  }))),
];
