import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const sourceExtension = /\.(?:[cm]?[tj]s|[tj]sx)$/u;
const ignoredDirectories = new Set(["node_modules", "dist", "coverage", ".git", ".worklab-tmp", "storybook-static", ".vite"]);

// App already depends on web, so this provider-free crash proof cannot
// represent its app-owned composition as a web -> app dependency.
export const WORKSPACE_IMPORT_EXCEPTIONS = [
  {
    file: "packages/web/src/__tests__/fixtures/ask-user-kill-worker.mjs",
    specifiers: ["../../../../app/dist/mcp/interaction-bridge.js"],
    reason: "App-owned AskUser crash integration; declaring app from web would create a cycle because app depends on web.",
  },
];

/** Include local additions but not ignored output; a missing Git index is not fatal. */
export function workspaceFileInventory(root, { runGit = execFileSync, warn = console.warn } = {}) {
  try {
    return [...new Set(runGit("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter((file) => file && existsSync(resolve(root, file))))];
  } catch {
    warn("Workspace import check: Git inventory unavailable; falling back to the filesystem walker.");
    return undefined;
  }
}

function sourceFiles(directory, packageRoot = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignoredDirectories.has(entry.name) || entry.name === "types"
      && (directory === packageRoot || existsSync(join(directory, "package.json")))) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, packageRoot);
    return entry.isFile() && sourceExtension.test(entry.name) ? [path] : [];
  });
}

function developmentFile(path) {
  return /(?:^|\/)(?:__tests__|__fixtures__|tests?|fixtures|\.storybook)(?:\/|$)/u.test(path)
    || path.startsWith("scripts/")
    || /\.(?:test|spec|stories)\.[^.]+$/u.test(path)
    || /(?:^|\/)(?:vite|vitest|playwright|eslint|prettier|tsup|storybook)(?:\.[^/]+)*\.config\.[^.]+$/u.test(path)
    || !path.split("/").includes("src") && /(?:^|\/)[^/]+\.config\.[^.]+$/u.test(path);
}

/** Literal module references, including types and JSDoc (which forEachChild omits). */
export function workspaceImportSpecifiers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  function add(node) {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && (node.text.startsWith("@mono-agent/") || node.text.startsWith("."))) {
      imports.push({ specifier: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isJSDocImportTag(node)) add(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (ts.isExternalModuleReference(node)) add(node.expression);
    else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const direct = expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(expression) && expression.text === "require";
      const member = ts.isPropertyAccessExpression(expression) && (
        ts.isIdentifier(expression.expression) && (expression.expression.text === "require" && expression.name.text === "resolve"
          || expression.expression.text === "vi" && ["mock", "importActual"].includes(expression.name.text))
        || ts.isMetaProperty(expression.expression) && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
          && expression.expression.name.text === "meta" && expression.name.text === "resolve"
      );
      if (direct || member) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
    for (const doc of node.jsDoc ?? []) visit(doc);
  }
  visit(source);
  return imports;
}

const inside = (directory, file) => {
  const path = relative(directory, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

function pathAliases(directory) {
  // Include project-reference configs (e.g. tsconfig.app.json) as well as the
  // solution config. TypeScript resolves extends; only paths, not input files,
  // are needed here. Alias matches remain subpath-specific, not package-wide.
  const aliases = new Set();
  for (const file of readdirSync(directory).filter((name) => /^tsconfig(?:\.[^.]+)*\.json$/u.test(name))) {
    const path = join(directory, file);
    const config = ts.readConfigFile(path, ts.sys.readFile);
    if (config.error) throw new Error(`Cannot read ${path}: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`);
    const parsed = ts.parseJsonConfigFileContent(config.config, { ...ts.sys, readDirectory: () => [] }, directory, {}, path);
    for (const alias of Object.keys(parsed.options.paths ?? {})) aliases.add(alias);
  }
  return [...aliases];
}

function aliasMatches(pattern, specifier) {
  const star = pattern.indexOf("*");
  return star === -1 ? pattern === specifier
    : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1))
      && specifier.length >= pattern.length - 1;
}

/** Check each manifest scope; relative targets obey the same declaration policy. */
export function findUndeclaredWorkspaceImports({ root, packagePath, manifest, workspaceNames, workspacePackages = [], trackedFiles }) {
  const directory = resolve(root, packagePath);
  const scopes = new Map();
  function scopeAt(path) {
    if (scopes.has(path)) return scopes.get(path);
    const ownManifest = path === directory ? manifest
      : existsSync(join(path, "package.json")) ? JSON.parse(readFileSync(join(path, "package.json"), "utf8")) : undefined;
    const scope = ownManifest ? { directory: path, manifest: ownManifest, aliases: pathAliases(path) } : scopeAt(dirname(path));
    scopes.set(path, scope);
    return scope;
  }
  const owners = workspacePackages.map((entry) => ({ ...entry, directory: resolve(root, entry.path) }))
    .sort((a, b) => b.directory.length - a.directory.length);
  // The inventory includes tracked and new nonignored files, but not deleted
  // paths. Standalone callers (or a missing Git index) use the filesystem walker.
  const files = trackedFiles ? trackedFiles.map((file) => resolve(root, file)).filter((file) => existsSync(file) && inside(directory, file) && sourceExtension.test(file))
    : sourceFiles(directory);
  const errors = [];
  for (const file of files.sort()) {
    const projectScope = scopeAt(dirname(file));
    // This embedded browser application ships inside @mono-agent/web: web owns
    // its bare runtime dependencies, while webapp's own aliases and tooling
    // layout remain authoritative. Parent-source relative imports are shared
    // implementation, not a webapp -> web dependency/build cycle.
    const embeddedWebapp = directory === resolve(root, "packages/web")
      && projectScope.directory === resolve(root, "packages/web/webapp");
    const scope = embeddedWebapp ? { ...projectScope, manifest } : projectScope;
    const path = relative(scope.directory, file).replaceAll("\\", "/");
    const manifestPath = relative(root, join(embeddedWebapp ? directory : scope.directory, "package.json")).replaceAll("\\", "/");
    const sourcePath = relative(root, file).replaceAll("\\", "/");
    const isDevelopment = developmentFile(path);
    const allowed = { ...scope.manifest.dependencies, ...scope.manifest.peerDependencies, ...scope.manifest.optionalDependencies,
      ...(isDevelopment ? scope.manifest.devDependencies : {}) };
    for (const { specifier, line } of workspaceImportSpecifiers(file, readFileSync(file, "utf8"))) {
      let name;
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        // Staying in a nested project is a self reference, not an import of its
        // enclosing workspace. Cross-project paths are resolved by owner root.
        if (inside(scope.directory, target) || embeddedWebapp && inside(directory, target)) continue;
        name = owners.find((entry) => inside(entry.directory, target))?.name;
        if (!name) continue; // Repository scripts and other non-package owners.
        if (WORKSPACE_IMPORT_EXCEPTIONS.some((entry) => entry.file === sourcePath && entry.specifiers.includes(specifier))) continue;
      } else {
        name = specifier.split("/").slice(0, 2).join("/");
        if (!workspaceNames.has(name)) continue;
        if (scope.aliases.some((alias) => aliasMatches(alias, specifier))) continue;
      }
      if (name === scope.manifest.name || Object.hasOwn(allowed, name)) continue;
      errors.push(`${sourcePath}:${line} imports ${specifier}, but ${name} is not declared in ${isDevelopment
        ? "dependencies, peerDependencies, optionalDependencies or devDependencies"
        : "dependencies, peerDependencies or optionalDependencies"} of ${manifestPath}.`);
    }
  }
  return errors;
}
