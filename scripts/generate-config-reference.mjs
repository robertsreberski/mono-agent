import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const {
  buildGeneratedConfigReferenceMarkdown,
  buildMonoAgentConfigSchema,
} = await import("../packages/app/dist/config-reference/config-reference.js");

const schemaPath = join(root, "packages/app/schema/mono-agent.config.schema.json");
// Served at https://mono-agent.dev/schema.json; must stay byte-identical to schemaPath.
const hostedSchemaPath = join(root, "marketing/public/schema.json");
const referencePath = join(root, "docs/config/reference.md");

const schema = `${JSON.stringify(buildMonoAgentConfigSchema(), null, 2)}\n`;

await mkdir(dirname(schemaPath), { recursive: true });
await mkdir(dirname(hostedSchemaPath), { recursive: true });
await mkdir(dirname(referencePath), { recursive: true });

await writeFile(schemaPath, schema);
await writeFile(hostedSchemaPath, schema);
await writeFile(referencePath, buildGeneratedConfigReferenceMarkdown());
