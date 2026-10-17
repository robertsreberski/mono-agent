// The object-schema constructor shared by builtin and MCP adaptation.


export function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
