import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createProgram, createParser, createFormatter, SchemaGenerator, DEFAULT_CONFIG, Context } from "ts-json-schema-generator";
import ts from "typescript";
import Ajv from "ajv";
import { ROUTES } from "./contract/routes.ts";
import { FIXTURES } from "./contract/fixtures.ts";
import { assertRouteCoverage } from "./contract/route-coverage.mjs";
import { MESSAGE_DELTA_VECTORS } from "../webapp/src/test/message-delta-vectors.ts";
import { browserCostWire } from "../src/cost-wire.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
export const SCHEMA_ID = "urn:mono-agent:web:console-api:v1";
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Mirror browserCostWire's numeric billing projection, not its opaque tool data.
 * Unknown/any remain open JSON values, including tool args/results and telemetry.
 */
function projectWireSchema(schema) {
  if (schema === null || typeof schema !== "object") return;
  if (schema.properties) {
    if (schema.properties.operations?.type === "number") Object.assign(schema.properties.operations, { type: "integer", minimum: 0 });
    for (const key of ["costUsd", "cost_usd", "cumulativeUsd", "cumulative_usd", "totalUsd", "total_usd", "cost", "monthUsd", "knownCostUsd", "known_cost_usd", "knownUsd", "monthKnownUsd"]) {
      const property = schema.properties[key];
      if (!property || !(property.type === "number" || Array.isArray(property.type) && property.type.includes("number"))) continue;
      const nullable = Array.isArray(property.type) && property.type.includes("null");
      property.type = "number";
      property.minimum = 0;
      if (nullable) {
        schema.required = schema.required?.filter((name) => name !== key);
        if (!["knownCostUsd", "known_cost_usd", "knownUsd", "monthKnownUsd"].includes(key)) {
          schema.properties[key === "monthUsd" ? "monthCostUnknown" : "costUnknown"] = { type: "boolean", const: true };
        }
      }
    }
  }
  for (const child of Object.values(schema)) {
    if (Array.isArray(child)) child.forEach(projectWireSchema);
    else projectWireSchema(child);
  }
}

export function generateContract() {
  // The generator uses cwd-relative anonymous type IDs. Normalize it so root,
  // package scripts and different checkout paths produce identical artifacts.
  const previous = process.cwd();
  try {
    process.chdir(root);
    return buildContract();
  } finally {
    process.chdir(previous);
  }
}

function buildContract() {
  assertRouteCoverage(read("src/server.ts"), ROUTES);
  const config = { ...DEFAULT_CONFIG,
    path: resolve(root, "src/api-contract.ts"), tsconfig: resolve(root, "tsconfig.contract.json"),
    type: "WebApiDtos", expose: "all", additionalProperties: false, jsDoc: "extended",
  };
  const program = createProgram(config);
  // The maintained generator exposes parser augmentation; resolve inline import
  // types (used by compaction accounting) through TS rather than weakening them.
  const checker = program.getTypeChecker();
  const parser = createParser(program, config, (chain) => chain.addNodeParser({
    supportsNode: (node) => ts.isImportTypeNode(node),
    createType(node, context) {
      const symbol = node.qualifier && checker.getSymbolAtLocation(node.qualifier);
      const resolved = symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
      const declaration = resolved?.declarations?.[0];
      if (!declaration) throw new Error(`Unresolved inline import type: ${node.getText()}`);
      const child = new Context(node);
      for (const arg of node.typeArguments ?? []) child.pushArgument(chain.createType(arg, context));
      return chain.createType(declaration, child);
    },
  }));
  const generated = new SchemaGenerator(program, parser, createFormatter(config), config).createSchema("WebApiDtos");
  const registry = generated.definitions.WebApiDtos;
  const aliases = registry.properties;
  delete generated.definitions.WebApiDtos;
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#", $id: SCHEMA_ID,
    title: "mono-agent console HTTP/SSE API v1",
    description: "Select a DTO with #/definitions/<manifest type>. Binary, Html and NoBody describe transports, not JSON. Unknown tool/telemetry values are intentionally open. Numeric costs use browserCostWire markers instead of null.",
    definitions: Object.fromEntries(Object.entries({ ...generated.definitions, ...aliases }).sort(([a], [b]) => a.localeCompare(b, "en"))),
  };
  projectWireSchema(schema);
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(schema);
  const fixtures = FIXTURES.map(({ name, type, value }) => {
    const wire = browserCostWire(value);
    return { name, type, value: wire, ...(type !== "ApiEvent" ? {} : {
      frame: `id: ${wire.id}\nevent: ${wire.type}\ndata: ${JSON.stringify(wire)}\n\n`,
    }) };
  });
  fixtures.push({ name: "message-delta-vectors", type: "ApiDeltaVectors", value: MESSAGE_DELTA_VECTORS });
  for (const fixture of fixtures) {
    const validate = ajv.getSchema(`${SCHEMA_ID}#/definitions/${fixture.type}`);
    if (!validate || !validate(fixture.value)) throw new Error(`Invalid fixture ${fixture.name}: ${ajv.errorsText(validate?.errors)}`);
  }
  for (const route of ROUTES) {
    for (const name of [route.requestType, route.responseType, route.queryType].filter(Boolean)) {
      if (!["NoBody", "Binary", "Html"].includes(name) && !ajv.getSchema(`${SCHEMA_ID}#/definitions/${name}`)) throw new Error(`Missing DTO ${name}`);
    }
  }
  return new Map([
    ["schema/console-api.v1.schema.json", json(schema)],
    ["schema/console-api.v1.routes.json", json({ version: 1, schema: "./console-api.v1.schema.json", routes: ROUTES })],
    ["schema/console-api.v1.fixtures.json", json({ version: 1, fixtures })],
    ["schema/message-delta-vectors.v1.json", json(MESSAGE_DELTA_VECTORS)],
  ]);
}

export function run({ check = false } = {}) {
  const outputs = generateContract();
  for (const [path, content] of outputs) {
    if (check) {
      let actual;
      try { actual = read(path); } catch { /* Missing artifacts are stale too. */ }
      if (actual !== content) throw new Error(`Stale console API contract: ${path}; run pnpm --filter @mono-agent/web run generate:api-contract`);
    } else {
      mkdirSync(resolve(root, "schema"), { recursive: true });
      writeFileSync(resolve(root, path), content);
    }
  }
  console.log(`Console API v1: ${outputs.size} artifacts ${check ? "checked" : "generated"}; ${ROUTES.length} routes.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run({ check: process.argv.includes("--check") });
