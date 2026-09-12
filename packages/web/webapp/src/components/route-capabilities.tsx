import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AgentSummary, CatalogModel } from "../types";
import { flattenCatalogModels } from "./route-label";

interface RouteCapabilities {
  readonly agent: AgentSummary | null;
  readonly catalogModels?: Readonly<Record<string, readonly CatalogModel[]>>;
}

const RouteCapabilitiesContext = createContext<RouteCapabilities>({ agent: null });

/**
 * Assistant-ui renders data parts without a props path to their agent. Supply
 * only the owning transcript's currently advertised scale, not a guessed or
 * historical capability snapshot. A standalone/unknown route keeps text.
 */
export function RouteCapabilitiesProvider({ agent, catalogByProvider, children }: {
  readonly agent: AgentSummary | null;
  readonly catalogByProvider?: Readonly<Record<string, { readonly models: readonly CatalogModel[] }>>;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => ({ agent, catalogModels: flattenCatalogModels(catalogByProvider) }), [agent, catalogByProvider]);
  return <RouteCapabilitiesContext value={value}>{children}</RouteCapabilitiesContext>;
}

export const useRouteCapabilities = (): RouteCapabilities => useContext(RouteCapabilitiesContext);
