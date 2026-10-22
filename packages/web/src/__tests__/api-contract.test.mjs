import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { assertRouteCoverage, discoverRoutes } from "../../scripts/contract/route-coverage.mjs";
import { browserCostWire } from "../cost-wire.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const schema = JSON.parse(read("../../schema/console-api.v1.schema.json"));
const manifest = JSON.parse(read("../../schema/console-api.v1.routes.json"));
const { fixtures } = JSON.parse(read("../../schema/console-api.v1.fixtures.json"));
const server = read("../server.ts");
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(schema);
const validate = (type, value) => ajv.getSchema(`${schema.$id}#/definitions/${type}`)(value);
const byName = (name) => fixtures.find((fixture) => fixture.name === name);
function discriminators(node) {
  if (node.$ref) return discriminators(schema.definitions[decodeURIComponent(node.$ref.split("/").at(-1))]);
  return node.properties?.type?.const ? [node.properties.type.const] : (node.anyOf ?? node.allOf ?? []).flatMap(discriminators);
}

describe("published console API v1", () => {
  it.each(fixtures.map((fixture) => [fixture.name, fixture]))("validates %s", (_name, fixture) => {
    const check = ajv.getSchema(`${schema.$id}#/definitions/${fixture.type}`);
    expect(check(fixture.value), ajv.errorsText(check.errors)).toBe(true);
    expect(browserCostWire(fixture.value)).toEqual(fixture.value);
    if (fixture.type === "ApiEvent") {
      expect(fixture.frame).toBe(`id: ${fixture.value.id}\nevent: ${fixture.value.type}\ndata: ${JSON.stringify(fixture.value)}\n\n`);
    }
  });

  it("covers every message role, rendered part kind and SSE event name", () => {
    const messages = byName("message-page").value.messages;
    expect(new Set(messages.map((message) => message.role))).toEqual(new Set(["user", "assistant", "system"]));
    expect(new Set(messages.flatMap((message) => message.parts.map((part) => part.type))))
      .toEqual(new Set(discriminators(schema.definitions.WebMessagePart)));
    expect(new Set(fixtures.filter((fixture) => fixture.type === "ApiEvent").map((fixture) => fixture.value.type)))
      .toEqual(new Set(discriminators(schema.definitions.WebTypedEvent)));
  });

  it("keeps exported delta vectors identical to the shared conformance corpus", async () => {
    const { MESSAGE_DELTA_VECTORS } = await import("../../webapp/src/test/message-delta-vectors.ts");
    expect(JSON.parse(read("../../schema/message-delta-vectors.v1.json"))).toEqual(MESSAGE_DELTA_VECTORS);
    expect(byName("message-delta-vectors").value).toEqual(MESSAGE_DELTA_VECTORS);
  });

  it("rejects wrong event payloads, missing required payloads and unsupported versions", () => {
    const event = byName("event-message.delta").value;
    expect(validate("ApiEvent", { ...event, payload: { messageId: "example" } })).toBe(false);
    const { payload: _payload, ...without } = event;
    expect(validate("ApiEvent", without)).toBe(false);
    expect(validate("ApiEvent", { ...event, version: 2 })).toBe(false);
    expect(validate("ApiEvent", { ...event, type: "future.event" })).toBe(false);
    expect(validate("ApiEvent", { ...event, type: "message.changed", payload: { messageId: "example", updatedAt: event.at, deltaDeclined: true } })).toBe(false);
    expect(validate("ApiEvent", { ...event, type: "agents.changed", payload: undefined })).toBe(true);
  });

  it("models wire cost markers, required nulls and opaque JSON without inventing types", () => {
    expect(validate("ApiCompaction", { ...byName("compaction").value, accounting: "not accounting" })).toBe(false);
    const { project } = byName("project").value;
    expect(project.monthUsd).toBeUndefined();
    expect(project.monthCostUnknown).toBe(true);
    expect(validate("ApiProject", { project: { ...project, monthUsd: null } })).toBe(false);
    const detail = byName("thread-detail").value;
    expect(validate("ApiThreadDetail", { ...detail, thread: { ...detail.thread, projectId: undefined } })).toBe(false);
    const tool = { type: "tool-call", toolCallId: "example", toolName: "Example", status: "complete", result: { arbitrary: [null, false, 1, "text"] } };
    expect(validate("ApiToolCall", { part: tool })).toBe(true);
  });

  it("matches every server registration and origin policy, in both directions", () => {
    expect(() => assertRouteCoverage(server, manifest.routes)).not.toThrow();
    expect(manifest.routes.length).toBe(discoverRoutes(server).length);
    expect(manifest.routes.find((route) => route.path === "/api/v1/mcp-app-proxy")?.responseType).toBe("Html");
    for (const route of manifest.routes) {
      expect(route.requiresClaimedOrigin).toBe(route.originPolicy !== "host");
      for (const type of [route.requestType, route.responseType, route.queryType].filter(Boolean)) {
        if (!["Binary", "NoBody", "Html"].includes(type)) expect(schema.definitions[type]).toBeDefined();
      }
    }
  });

  it("fails on added, removed, duplicate, dynamic and origin-changed routes", () => {
    expect(() => assertRouteCoverage(`${server}\napp.get('/api/v1/unlisted', (_req, res) => res.json({}));`, manifest.routes)).toThrow(/missing=GET \/api\/v1\/unlisted/);
    expect(() => assertRouteCoverage(server.replace('app.get("/api/v1/bootstrap"', 'app.get("/excluded-bootstrap"'), manifest.routes)).toThrow(/extra=GET \/api\/v1\/bootstrap/);
    expect(() => assertRouteCoverage(server, [...manifest.routes, manifest.routes[0]])).toThrow(/Duplicate manifest/);
    expect(() => assertRouteCoverage(`${server}\napp.post(newRoute, handler);`, manifest.routes)).toThrow(/dynamic route/);
    expect(() => assertRouteCoverage(`${server}\napp.route('/api/v1/unlisted').get(handler);`, manifest.routes)).toThrow(/app.route/);
    expect(() => assertRouteCoverage(server.replace('app.get("/api/v1/bootstrap", (req, res, next) => {', 'app.get("/api/v1/bootstrap", (req, res, next) => { exactRequestOrigin(req);'), manifest.routes)).toThrow(/origin=GET \/api\/v1\/bootstrap/);
  });
});
