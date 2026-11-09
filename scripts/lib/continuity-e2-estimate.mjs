// Content-free offline reservation estimate. This is not authorization or a completion promise.
import { E2_PAID_ROLES, E2_CENTRAL_CACHE, E2_USD_UNITS, e2CatalogRates, e2RequestPrice } from "./continuity-e2-pricing.mjs";
import { SOL, LUNA } from "./continuity-e2-protocol.mjs";
const need = ok => { if (!ok) throw Object.assign(Error("E2_ESTIMATE_INVALID"), { code: "E2_ESTIMATE_INVALID" }); };
const count = n => Number.isSafeInteger(n) && n >= 0;
const object = v => v && typeof v === "object" && !Array.isArray(v);
const fields = (v, required, optional = []) => object(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...required, ...optional].includes(k));
const key = row => `${row.role}:${row.model}`;
export function validateE2Sizing(size) {
  need(fields(size, ["method", "serializedBytes", "serializedBytesOver3", "engineFullRequest", "maximum", "usage"])
    && size.method === "intercepted-full-models-context" && size.usage === "engine-estimate-not-provider-measurement"
    && [size.serializedBytes, size.serializedBytesOver3, size.engineFullRequest, size.maximum].every(count)
    && size.serializedBytesOver3 === Math.ceil(size.serializedBytes / 3)
    && size.maximum === Math.max(size.serializedBytesOver3, size.engineFullRequest) && size.maximum > 0);
  return size;
}
export function estimateE2Reservations({ roles, requests, catalog }) {
  need(Array.isArray(roles) && roles.length > 0 && roles.length <= E2_PAID_ROLES.length * 2
    && Array.isArray(requests) && requests.length > 0 && requests.length <= 100000 && Array.isArray(catalog));
  const models = new Map(catalog.map(row => [row?.model, row])); need(models.size === catalog.length);
  const registered = new Map();
  for (const role of roles) {
    need(fields(role, ["role", "model", "maxInputTokens", "maxOutputTokens"]) && E2_PAID_ROLES.includes(role.role)
      && [SOL, LUNA].includes(role.model) && count(role.maxInputTokens) && role.maxInputTokens > 0 && !registered.has(key(role)));
    const row = models.get(role.model); e2CatalogRates(row, role.maxInputTokens);
    const maximum = e2RequestPrice(row, { inputTokens: role.maxInputTokens, maxOutputTokens: role.maxOutputTokens });
    registered.set(key(role), { ...role, catalog: row, maximum: BigInt(maximum.reservationUnits) });
  }
  const groups = new Map(); let scriptedRequests = 0;
  for (const request of requests) {
    need(fields(request, ["checkpoint", "role", "model", "size"], ["maxOutputTokens"]) && count(request.checkpoint)
      && [SOL, LUNA].includes(request.model) && [...E2_PAID_ROLES, "setup-scripted"].includes(request.role));
    const size = validateE2Sizing(request.size);
    if (request.role === "setup-scripted") { scriptedRequests++; continue; }
    const role = registered.get(key(request)); need(role && size.maximum <= role.maxInputTokens);
    const cached = Math.floor(size.maximum * E2_CENTRAL_CACHE.numerator / E2_CENTRAL_CACHE.denominator);
    const central = e2RequestPrice(role.catalog, { inputTokens: size.maximum, maxOutputTokens: role.maxOutputTokens, cachedInputTokens: cached });
    const groupKey = `${request.checkpoint}:${key(request)}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { checkpoint: request.checkpoint, role: role.role, model: role.model, requests: 0,
      maxInputTokens: role.maxInputTokens, maxOutputTokens: role.maxOutputTokens, maxReservationUnits: role.maximum.toString(), maximumUnits: 0n, centralUnits: 0n, noCacheUnits: 0n });
    const row = groups.get(groupKey); row.requests++; row.maximumUnits += role.maximum;
    row.centralUnits += BigInt(central.estimateUnits); row.noCacheUnits += BigInt(central.reservationUnits);
  }
  need(groups.size > 0);
  const rows = [...groups.values()].sort((a, b) => a.checkpoint - b.checkpoint || a.role.localeCompare(b.role) || a.model.localeCompare(b.model));
  const total = { requests: 0, maximumUnits: 0n, centralUnits: 0n, noCacheUnits: 0n };
  for (const row of rows) for (const field of Object.keys(total)) total[field] += row[field];
  const serial = row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return { schema: "continuity-e2-cap-estimate-v1", unitsPerUSD: E2_USD_UNITS.toString(), semanticQualification: false,
    assumptions: { centralCache: E2_CENTRAL_CACHE, output: "registered-per-request-limit", maximum: "registered-input-bound-no-cache", completionGuaranteed: false },
    scriptedRequests, checkpoints: rows.map(serial), totals: serial(total), minimumCapUnits: total.maximumUnits.toString() };
}
