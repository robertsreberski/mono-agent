import { toToolDeclaration } from "@earendil-works/pi-ai";

const memo = new WeakMap();
const APIS = new Set(["openai-completions", "google-generative-ai", "google-vertex", "google-gemini-cli"]);
const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const lists = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const singles = new Set(["items", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "not", "if", "then", "else", "propertyNames", "additionalItems"]);
const kind = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array"
  : typeof value === "number" ? Number.isInteger(value) ? "integer" : "number" : typeof value;
function infer(schema: any) {
  const values = Object.hasOwn(schema, "const") ? [schema.const] : schema.enum;
  if (Array.isArray(values) && values.length) {
    const types = new Set(values.map(kind));
    if (types.size === 1) return [...types][0];
    if ([...types].every((type) => type === "integer" || type === "number")) return "number";
    return undefined;
  }
  // Do not narrow a union/ref using incidental structural annotations.
  if (schema.$ref || schema.anyOf || schema.oneOf || schema.allOf) return undefined;
  if ((schema.properties || schema.required) && !schema.items && !schema.prefixItems) return "object";
  if ((schema.items || schema.prefixItems) && !schema.properties && !schema.required) return "array";
}
function adapt(schema: any) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const copy = { ...schema };
  for (const [key, value] of Object.entries(schema)) {
    if (maps.has(key) && value && typeof value === "object" && !Array.isArray(value))
      copy[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, adapt(child)]));
    else if (lists.has(key) && Array.isArray(value)) copy[key] = value.map(adapt);
    else if (singles.has(key)) copy[key] = Array.isArray(value) ? value.map(adapt) : adapt(value);
  }
  if (copy.type === undefined) {
    const type = infer(copy);
    if (type) copy.type = type;
  }
  return copy;
}

/** Memoized provider-only declarations; never pass these to the agent loop validator. */
export function adaptRequestTools(tools: any, api: any) {
  if (!APIS.has(api)) return tools;
  let byApi = memo.get(tools);
  if (!byApi) { byApi = new Map(); memo.set(tools, byApi); }
  if (!byApi.has(api)) byApi.set(api, tools.map((tool: any) => tool.parameters ? { ...tool, parameters: adapt(structuredClone(tool.parameters)) } : tool));
  return byApi.get(api);
}

/** Swap only the provider-facing leading transcript declaration, after Pi has
 * retained the original executable tools for validation and execution. */
export function adaptProviderContext(context: any, tools: any, api: any) {
  const adapted = adaptRequestTools(tools, api);
  if (adapted === tools || tools.length === 0) return context;
  return { ...context, messages: context.messages.map((message: any, index: number) => index === 0 && message.role === "system"
    ? { ...message, toolsAdded: adapted.map(toToolDeclaration) } : message) };
}
