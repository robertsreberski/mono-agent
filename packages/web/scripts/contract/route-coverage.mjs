import { readFileSync } from "node:fs";
import ts from "typescript";

// Resolve the imported path without executing the HTML proxy module. All other
// nonliteral registrations fail closed until discovery explicitly supports them.
const proxyFile = ts.createSourceFile("mcp-app-proxy.ts",
  readFileSync(new URL("../../src/mcp-app-proxy.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function proxyPath() {
  let path;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(proxyFile) === "MCP_APP_PROXY_PATH"
      && node.initializer && ts.isStringLiteralLike(node.initializer)) path = node.initializer.text;
    ts.forEachChild(node, visit);
  }
  visit(proxyFile);
  if (!path) throw new Error("MCP_APP_PROXY_PATH must remain a literal for route discovery");
  return path;
}

/** Discover registrations independently of the manifest. Middleware is not a route. */
export function discoverRoutes(source) {
  const file = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true);
  // Bind identifiers without resolving/executing imports. A matching spelling
  // is not authority: aliases are accepted, local/shadowed declarations are not.
  const options = { noResolve: true, noLib: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === "server.ts" ? file : undefined;
  const checker = ts.createProgram(["server.ts"], options, host).getTypeChecker();
  function registrarPath(identifier) {
    const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
    if (!declaration || !ts.isImportSpecifier(declaration) || declaration.isTypeOnly
      || !["registerCapabilityActionRoutes", "registerCredentialRoutes"].includes((declaration.propertyName ?? declaration.name).text)) return undefined;
    const clause = declaration.parent.parent;
    if (clause.isTypeOnly || !ts.isImportDeclaration(clause.parent) || !ts.isStringLiteral(clause.parent.moduleSpecifier)) return undefined;
    const name = (declaration.propertyName ?? declaration.name).text;
    const expected = name === "registerCredentialRoutes" ? "credential-routes" : "capability-action-routes";
    return clause.parent.moduleSpecifier.text === `./${expected}.js` ? expected : undefined;
  }
  const routes = [];
  const verbs = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
  function visit(node) {
    // This imported registration owner uses literal routes and the same origin callback.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && registrarPath(node.expression)) {
      routes.push(...discoverRoutes(readFileSync(new URL(`../../src/${registrarPath(node.expression)}.ts`, import.meta.url), "utf8")));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(file) === "app" && verbs.has(node.expression.name.text)) {
      const [path, ...handlers] = node.arguments;
      const literal = path && ts.isStringLiteralLike(path) ? path.text
        : path?.getText(file) === "MCP_APP_PROXY_PATH" ? proxyPath() : undefined;
      if (literal === undefined) throw new Error(`Unsupported dynamic route: ${path?.getText(file)}`);
      if (literal.startsWith("/api/v1") || literal === "/healthz") {
        let originPolicy = "host";
        function inspect(child) {
          if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
            if (child.expression.text === "exactRequestOrigin") originPolicy = "exact";
            if (child.expression.text === "sameOriginRead") originPolicy = "claimed";
          }
          ts.forEachChild(child, inspect);
        }
        for (const handler of handlers) inspect(handler);
        routes.push({ method: node.expression.name.text.toUpperCase(), path: literal, originPolicy });
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(file) === "app" && node.expression.name.text === "route") {
      throw new Error("Unsupported app.route registration; extend contract discovery first");
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return routes;
}

export function assertRouteCoverage(source, manifest) {
  const key = (route) => `${route.method} ${route.path}`;
  const discovered = discoverRoutes(source);
  for (const [label, routes] of [["server", discovered], ["manifest", manifest]]) {
    if (new Set(routes.map(key)).size !== routes.length) throw new Error(`Duplicate ${label} routes`);
  }
  const actual = new Map(discovered.map((route) => [key(route), route.originPolicy]));
  const expected = new Map(manifest.map((route) => [key(route), route.originPolicy]));
  const missing = [...actual.keys()].filter((entry) => !expected.has(entry));
  const extra = [...expected.keys()].filter((entry) => !actual.has(entry));
  const originDrift = [...actual.keys()].filter((entry) => expected.has(entry) && expected.get(entry) !== actual.get(entry));
  if (missing.length || extra.length || originDrift.length) {
    throw new Error(`Route contract drift: missing=${missing.join(", ")}; extra=${extra.join(", ")}; origin=${originDrift.join(", ")}`);
  }
}
