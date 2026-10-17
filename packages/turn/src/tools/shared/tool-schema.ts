// The object-schema constructor shared by builtin and MCP adaptation.


export function objectSchema(properties: any, required: any[] = []): { type: string; properties: any; required: any[]; additionalProperties: boolean } {
  return { type: "object", properties, required, additionalProperties: false };
}
