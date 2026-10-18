import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const { compareGraphs } = await import(new URL("../../scripts/compare-public-declarations.mjs", import.meta.url).href) as {
  compareGraphs(baseline: string, candidate: string, entries: { key: string; types: string }[], options?: { documentationMode: "literal" | "semantic" }): {
    entry: string; exports: number; errors: string[];
  }[];
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function comparisonDirectory() {
  const root = fileURLToPath(new URL("../../../../.worklab-tmp/turn-declaration-tests/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "comparison-"));
  directories.push(directory);
  return directory;
}
function compare(before: string, after: string) {
  const directory = comparisonDirectory();
  for (const [name, text] of [["baseline", before], ["candidate", after]] as const) {
    mkdirSync(join(directory, name));
    writeFileSync(join(directory, name, "index.d.ts"), text);
  }
  return compareGraphs(join(directory, "baseline"), join(directory, "candidate"), [{ key: ".", types: "index.d.ts" }])[0]!.errors;
}

it("rejects alias/interface changes despite identical members", () => {
  expect(compare('export type Shape = { readonly value: unknown; optional?: string };',
    'export interface Shape { readonly value: unknown; optional?: string }')).toContain('Shape: changed alias/interface declaration kind');
});

it.each([
  ["optional positional parameter", 'export function run(value?: number): void;', 'export function run(value: number): void;', "new required parameter"],
  ["optional inline input member", 'export function run(options: { value?: number }): void;', 'export function run(options: { value: number }): void;', "optional became required"],
  ["optional interface input member", 'interface Options { value?: number } export function run(options: Options): void;', 'interface Options { value: number } export function run(options: Options): void;', "optional became required"],
  ["optional nested input member", 'export function run(options: { nested?: { value?: number } }): void;', 'export function run(options: { nested?: { value: number } }): void;', "optional became required"],
  ["unconsumed exported interface member", 'export interface Shape { value?: number }', 'export interface Shape { value: number }', "optional became required"],
  ["unconsumed exported alias member", 'export type Shape = { value?: number };', 'export type Shape = { value: number };', "optional became required"],
  ["unconsumed nested member", 'export interface Shape { nested: { value?: number } }', 'export interface Shape { nested: { value: number } }', "optional became required"],
  ["unconsumed array element member", 'export type Shape = { value?: number }[];', 'export type Shape = { value: number }[];', "optional became required"],
  ["unconsumed promise member", 'export type Shape = Promise<{ value?: number }>;', 'export type Shape = Promise<{ value: number }>;', "optional became required"],
  ["unconsumed intersection member", 'export type Shape = { value?: number } & { other: string };', 'export type Shape = { value: number } & { other: string };', "optional became required"],
  ["unconsumed union member", 'export type Shape = { kind: "one"; value?: number } | { kind: "two" };', 'export type Shape = { kind: "one"; value: number } | { kind: "two" };', "optional became required"],
  ["unconsumed generic member", 'interface Box<T> { item: T }; export interface Shape { first: Box<string>; second: Box<{ value?: number }> }', 'interface Box<T> { item: T }; export interface Shape { first: Box<string>; second: Box<{ value: number }> }', "optional became required"],
  ["dual-use exported member", 'export interface Shape { value?: number } export function run(value: Shape): Shape;', 'export interface Shape { value: number } export function run(value: Shape): Shape;', "optional became required"],
  ["optional output member", 'export function run(): { value?: number };', 'export function run(): { value: number };', "optional became required"],
  ["conservative callback parameter", 'export function run(callback: (value: string) => void): void;', 'export function run(callback: (value: string | number) => void): void;', "widened union"],
  ["narrowed any parameter", 'export function run(value: any): void;', 'export function run(value: string): void;', "changed baseline any"],
  ["narrowed any return", 'export function run(): any;', 'export function run(): string;', "changed baseline any"],
  ["narrowed any property", 'export interface Shape { value: any }', 'export interface Shape { value: null }', "changed baseline any"],
  ["narrowed any type argument", 'export function run(): Promise<any>;', 'export function run(): Promise<string>;', "changed baseline any"],
  ["lost export docs", '/** Public shape. */ export interface Shape { value: string }', 'export interface Shape { value: string }', "lost documentation"],
  ["lost member docs", 'export interface Shape {\n/** Public value. */\nvalue: string\n}', 'export interface Shape { value: string }', "lost documentation"],
  ["intersection inner unknown", 'export type Shape = { a: unknown } & { b: string };', 'export type Shape = { a: any } & { b: string };', "introduced any"],
  ["intersection readonly", 'export type Shape = { readonly a: string } & { b: string };', 'export type Shape = { a: string } & { b: string };', "lost readonly"],
  ["intersection index", 'export type Shape = Readonly<Record<string, unknown>> & { readonly sandbox?: never };', 'export type Shape = Record<string, any>;', "introduced any"],
  ["indirect alias/interface", 'type Internal = { value: string }; export type Shape = Internal;', 'interface Internal { value: string }; export type Shape = Internal;', "changed alias/interface"],
  ["Readonly unknown", 'interface I { value: unknown }; export type Shape = Readonly<I>;', 'interface I { value: any }; export type Shape = Readonly<I>;', "introduced any"],
  ["Partial widening", 'interface I { value: "one" }; export type Shape = Partial<I>;', 'interface I { value: string }; export type Shape = Partial<I>;', "widened"],
  ["Omit readonly", 'interface I { readonly value: string; ignored: number }; export type Shape = Omit<I,"ignored">;', 'interface I { value: string; ignored: number }; export type Shape = Omit<I,"ignored">;', "lost readonly"],
  ["Pick unknown", 'interface I { value: unknown }; export type Shape = Pick<I,"value">;', 'interface I { value: any }; export type Shape = Pick<I,"value">;', "introduced any"],
  ["Record unknown", 'export type Shape = Record<string, unknown>;', 'export type Shape = Record<string, any>;', "introduced any"],
  ["nested runtime options", 'export interface Options { native?: { context: Readonly<Record<string, unknown>> } }', 'export interface Options { native?: { context: any } }', "introduced any"],
  ["distinct mapped instances", 'export interface Shape { first: Readonly<{ value: string }>; second: Readonly<{ value: unknown }> }', 'export interface Shape { first: Readonly<{ value: string }>; second: Readonly<{ value: any }> }', "introduced any"],
  ["readonly", 'export interface Shape { readonly value: string }', 'export interface Shape { value: string }', "lost readonly"],
  ["unknown", 'export interface Shape { value: unknown }', 'export interface Shape { value: any }', "introduced any"],
  ["optionality", 'export interface Shape { value: string }', 'export interface Shape { value?: string }', "required became optional"],
  ["removed member", 'export interface Shape { value: string }', 'export interface Shape {}', "removed member"],
  ["literal widening", 'export type Shape = "one";', 'export type Shape = string;', "widened"],
  ["explicit undefined", 'export interface Shape { value?: string }', 'export interface Shape { value?: string | undefined }', "widened"],
  ["removed overload", 'export function run(value: string): string; export function run(value: number): number;', 'export function run(value: string): string;', "removed overload"],
  ["callback", 'export function run(callback: () => unknown): void;', 'export function run(callback: () => any): void;', "introduced any"],
  ["array", 'export interface Shape { values: readonly string[] }', 'export interface Shape { values: string[] }', "lost readonly"],
  ["mapped readonly", 'export type Shape = Readonly<{ value: string }>;', 'export type Shape = { value: string };', "lost readonly"],
  ["generic instantiations", 'interface Box<T> { value: T }; export interface Shape { first: Box<string>; second: Box<unknown> }', 'interface Box<T> { value: T }; export interface Shape { first: Box<string>; second: Box<any> }', "introduced any"],
])("rejects a seeded %s regression", (_name, before, after, message) => {
  expect(compare(before!, after!).some((error) => error.includes(message!))).toBe(true);
});

it.each([
  'export interface Shape { value?: number }',
  'export type Shape = Readonly<{ nested?: { value?: number } }[]>;',
  'export function run(callback: (value?: number) => void): { value?: number };',
])("accepts unchanged optional guarantees in %s", (declaration) => {
  expect(compare(declaration, declaration)).toEqual([]);
});

it.each(["export", "member"] as const)("compares normalized %s documentation text", (position) => {
  const declaration = (doc: string) => position === "export"
    ? `${doc}\nexport interface Shape { value: string }`
    : `export interface Shape {\n${doc}\nvalue: string\n}`;
  const baseline = declaration("/** Public value. Keep this guarantee. */");
  expect(compare(baseline, declaration("/** Different value. Keep this guarantee. */")))
    .toContain(`${position === "export" ? "Shape" : "Shape.value"}: changed documentation`);
  expect(compare(baseline, declaration("/** Public value. */")))
    .toContain(`${position === "export" ? "Shape" : "Shape.value"}: changed documentation`);
  expect(compare(baseline, declaration("")))
    .toContain(`${position === "export" ? "Shape" : "Shape.value"}: lost documentation`);
  expect(compare(declaration(""), baseline)).toEqual([]);
  expect(compare(baseline, declaration("/**\n * Public value.\n * Keep this guarantee.\n */"))).toEqual([]);
});

it.each([
  ["deprecated tag", "/** Public shape.\n * @deprecated Use replacement.\n */", "/** Public shape. */"],
  ["tag-only deprecated", "/** @deprecated Use replacement. */", ""],
])("rejects a dropped %s", (_name, before, after) => {
  expect(compare(`${before} export interface Shape { value: string }`,
    `${after} export interface Shape { value: string }`)).toContain("Shape: lost documentation tags");
});

it.each([
  ["param", "@param value Original input.", "@param value Changed input.", "value: string"],
  ["destructured param property", "@param options.value Original input.", "@param options.value Changed input.", "{ value }: { value: string }"],
  ["returns", "@returns Original output.", "@returns Changed output.", "value: string"],
])("compares %s descriptions on symbols and signatures", (_name, before, after, parameter) => {
  const declaration = (tag: string) => `/** Public call.\n * ${tag}\n */ export function run(${parameter}): string;`;
  const errors = compare(declaration(before!), declaration(after!));
  expect(errors).toContain("run: changed documentation tags");
  expect(errors).toContain("run.signature[0]: changed documentation tags");
});

it.each(["description", "tag"])("rejects %s documentation moved between overloads", (kind) => {
  const doc = kind === "description" ? "/** String overload. */" : "/** @deprecated Use replacement. */";
  const first = "export function run(value: string): string;";
  const second = "export function run(value: number): number;";
  const errors = compare(`${doc} ${first}\n${second}`, `${first}\n${doc} ${second}`);
  expect(errors.some((error) => error.startsWith("run.signature[0]: lost documentation"))).toBe(true);
});

it.each([
  ["paragraph", "First paragraph.\n\nSecond paragraph.", "First paragraph. Second paragraph."],
  ["list", "A.\n\n- b\n- c", "A. - b - c"],
  ["list items", "A.\n\n- b\n- c", "A.\n\n- b - c"],
])("preserves %s structure", (_name, before, after) => {
  const declaration = (text: string) => `/**\n * ${text.replaceAll("\n", "\n * ")}\n */ export interface Shape { value: string }`;
  expect(compare(declaration(before!), declaration(after!))).toContain("Shape: changed documentation");
});

it("allows paragraph and tag re-wrapping without flattening their structure", () => {
  expect(compare(`/** A paragraph with words.
 *
 * - First item with words.
 * - Second item.
 * @deprecated Use replacement with options.
 */ export function run(): void;`, `/** A paragraph
 * with words.
 *
 * - First item
 *   with words.
 * - Second item.
 * @deprecated Use replacement
 * with options.
 */ export function run(): void;`)).toEqual([]);
  expect(compare("export function run(): void;", "/** @deprecated Use replacement. */ export function run(): void;")).toEqual([]);
});

it.each(["any", "Record<string, any>"])("detects the real host runtime-options intersection changed to %s", (replacement) => {
  const turn = fileURLToPath(new URL("../../", import.meta.url));
  const directory = comparisonDirectory();
  const manifest = JSON.parse(readFileSync(join(turn, "package.json"), "utf8")) as { name: string; exports: Record<string, { types: string }> };
  for (const label of ["baseline", "candidate"]) {
    const target = join(directory, label);
    mkdirSync(target);
    cpSync(join(turn, "types"), join(target, "types"), { recursive: true });
    writeFileSync(join(target, "package.json"), JSON.stringify({ ...manifest, name: `@mutation/${label}` }));
    symlinkSync(join(turn, "node_modules"), join(target, "node_modules"), "dir");
  }
  const path = join(directory, "candidate/types/host/runtime-options.d.ts");
  const before = readFileSync(path, "utf8");
  expect(before).toContain("Readonly<Record<string, unknown>>");
  const expression = /Readonly<Record<string, unknown>> & \{[^}]+\}/u;
  expect(before).toMatch(expression);
  writeFileSync(path, before.replace(expression, replacement));
  const rows = compareGraphs(join(directory, "baseline"), join(directory, "candidate"),
    [{ key: "./host/types", types: manifest.exports["./host/types"]!.types }]);
  expect(rows.some((row) => row.errors.some((error) => error.includes("introduced any")))).toBe(true);
});

it("rejects making the real WebFetch output limit required", () => {
  const turn = fileURLToPath(new URL("../../", import.meta.url));
  const directory = comparisonDirectory();
  const manifest = JSON.parse(readFileSync(join(turn, "package.json"), "utf8")) as { exports: Record<string, { types: string }> };
  for (const label of ["baseline", "candidate"]) {
    const target = join(directory, label);
    mkdirSync(target);
    cpSync(join(turn, "types"), join(target, "types"), { recursive: true });
    writeFileSync(join(target, "package.json"), JSON.stringify({ ...manifest, name: `@mutation/${label}` }));
    symlinkSync(join(turn, "node_modules"), join(target, "node_modules"), "dir");
  }
  const path = join(directory, "candidate/types/tools/web/web-fetch.d.ts");
  const before = readFileSync(path, "utf8");
  expect(before).toContain("max_output_chars?: number;");
  writeFileSync(path, before.replaceAll("max_output_chars?: number;", "max_output_chars: number;"));
  const rows = compareGraphs(join(directory, "baseline"), join(directory, "candidate"),
    [{ key: "./tools", types: manifest.exports["./tools"]!.types }]);
  expect(rows.some((row) => row.errors.some((error) => error.includes("max_output_chars: optional became required")))).toBe(true);
});

it("rejects making a real type-only host retry policy member required", () => {
  const turn = fileURLToPath(new URL("../../", import.meta.url));
  const directory = comparisonDirectory();
  const manifest = JSON.parse(readFileSync(join(turn, "package.json"), "utf8")) as { exports: Record<string, { types: string }> };
  for (const label of ["baseline", "candidate"]) {
    const target = join(directory, label);
    mkdirSync(target);
    cpSync(join(turn, "types"), join(target, "types"), { recursive: true });
    writeFileSync(join(target, "package.json"), JSON.stringify({ ...manifest, name: `@mutation/${label}` }));
    symlinkSync(join(turn, "node_modules"), join(target, "node_modules"), "dir");
  }
  const path = join(directory, "candidate/types/host/runtime-options.d.ts");
  const before = readFileSync(path, "utf8");
  expect(before).toContain("readonly backoffMs?: number;");
  writeFileSync(path, before.replace("readonly backoffMs?: number;", "readonly backoffMs: number;"));
  const rows = compareGraphs(join(directory, "baseline"), join(directory, "candidate"),
    [{ key: "./host/types", types: manifest.exports["./host/types"]!.types }]);
  expect(rows.some((row) => row.errors.some((error) => error.includes("backoffMs: optional became required")))).toBe(true);
});

it.each([
  ["type annotation", "/** @type {string} */ export const value: string;", "export const value: string;"],
  ["empty parameter/return tags", "/** @param {string} value\n * @returns {string}\n */ export function run(value: string): string;", "export function run(value: string): string;"],
  ["property attribution", "/** @typedef {Object} Shape\n * @property {string} value Public value.\n */ export const sentinel: number;\n export type Shape = { value: string };", "export const sentinel: number;\n export type Shape = {\n /** Public value. */\n value: string };"],
  ["SearchProvider attribution", "/** Source-level provider contract.\n * @typedef {Object} SearchProvider\n * @property {string} name\n */ export const providers: Map<string, SearchProvider>;\n export type SearchProvider = { name: string };", "export const providers: Map<string, SearchProvider>;\n /** Source-level provider contract. */\n export type SearchProvider = { name: string };"],
  ["callback attribution", "/** Completion callback.\n * @callback Done\n * @param {string} value Input value.\n */ export const sentinel: number;\n export type Done = (value: string) => void;", "export const sentinel: number;\n /** Completion callback.\n * @param value Input value.\n */ export type Done = (value: string) => void;"],
])("semantically accepts %s cleanup", (_name, before, after) => {
  expect(compare(before!, after!)).toEqual([]);
});

it.each([
  ["parameter", "/** @param {string} value Input value. */", ""],
  ["return", "/** @returns {string} Output value. */", ""],
  ["type prose", "/** @type {Function} Public call. */", ""],
  ["deprecated marker", "/** @deprecated */", ""],
  ["example braces", "/** @example const x = { value: 1 }; */", "/** @example const x = { value: 2 }; */"],
  ["unknown prose tag", "/** @custom Original prose. */", "/** @custom Changed prose. */"],
  ["throws prose", "/** @throws {Error} Original failure. */", "/** @throws {Error} Changed failure. */"],
])("rejects removed/changed %s prose", (_name, before, after) => {
  const declaration = "export function run(value: string): string;";
  expect(compare(`${before} ${declaration}`, `${after} ${declaration}`).some((error) => error.includes("documentation"))).toBe(true);
});

it("rejects prose moved to another symbol, including a wrong typedef target", () => {
  const declarations = "export type First = { value: string };\n export type Second = { value: string };";
  expect(compare(`/** Original prose. */ ${declarations}`, `export type First = { value: string };\n /** Original prose. */ export type Second = { value: string };`)).toContain("First: lost documentation");
  expect(compare(`/** Original prose.\n * @typedef {Object} First\n */ export const sentinel: number;\n ${declarations}`,
    `/** Original prose.\n * @typedef {Object} Second\n */ export const sentinel: number;\n ${declarations}`)).toContain("First: lost documentation");
});

it.each([
  ["bar", "export const bar: number;"],
  ["Baz", "export type Baz = { value: number };"],
])("rejects candidate prose left only in a dead typedef above %s", (_name, unrelated) => {
  const shape = "export type Foo = { value: string };";
  const before = `/** Foo is the record. */ ${shape}\n ${unrelated}`;
  const after = `${shape}\n /** @typedef {object} Foo Foo is the record. */ ${unrelated}`;
  expect(compare(before, after)).toContain("Foo: lost documentation");
});

it("rejects candidate prose left only in a dead callback", () => {
  const shape = "export type Foo = () => void;";
  expect(compare(`/** Foo is the callback. */ ${shape}\n export const bar: number;`,
    `${shape}\n /** @callback Foo Foo is the callback. */ export const bar: number;`)).toContain("Foo: lost documentation");
});

it("retains literal documentation comparison for type-only tags", () => {
  const directory = comparisonDirectory();
  for (const name of ["baseline", "candidate"]) {
    mkdirSync(join(directory, name));
    writeFileSync(join(directory, name, "index.d.ts"), `${name === "baseline" ? "/** @type {string} */" : ""} export const value: string;`);
  }
  expect(compareGraphs(join(directory, "baseline"), join(directory, "candidate"), [{ key: ".", types: "index.d.ts" }],
    { documentationMode: "literal" })[0]!.errors).toContain("value: lost documentation tags");
});

it("ignores JSDoc overload type syntax but preserves nested descriptions", () => {
  const declaration = "export function run(value: string): string;";
  expect(compare(`/** @overload\n * @param {string} value\n * @returns {string}\n */ ${declaration}`, declaration)).toEqual([]);
  expect(compare(`/** @overload\n * @param {string} value Input value.\n * @returns {string} Output value.\n */ ${declaration}`,
    `/** @param value Input value.\n * @returns Output value.\n */ ${declaration}`)).toEqual([]);
  expect(compare(`/** @overload\n * @param {string} value Input value.\n */ ${declaration}`, declaration).some((error) => error.includes("lost documentation tags"))).toBe(true);
});

it("treats inline scoped package names as prose without swallowing property tags", () => {
  const before = "/** @typedef {Object} Policy\n * Defined by @scope/package.\n * @property {string} mode\n * @property {boolean} trusted Trusted capability.\n */ export const sentinel: number;\n export type Policy = { mode?: string; trusted?: boolean };";
  const after = "export const sentinel: number;\n /** Defined by @scope/package. */ export type Policy = { mode?: string;\n /** Trusted capability. */ trusted?: boolean };";
  expect(compare(before, after)).toEqual([]);
  expect(compare(before, after.replace("@scope/package", "@scope/other")).some((error) => error.includes("changed documentation"))).toBe(true);
  expect(compare(before, after.replace("Trusted capability.", "Different capability.")).some((error) => error.includes("changed documentation"))).toBe(true);
});

it("preserves property prose when the baseline type is opaque", () => {
  const before = "/** @typedef {Object} Policy\n * @property {string} mode Mode description.\n */ export const sentinel: number;\n export type Policy = any;";
  const after = "export const sentinel: number;\n /** @property mode Mode description. */ export type Policy = any;";
  expect(compare(before, after)).toEqual([]);
  expect(compare(before, after.replace("Mode description.", "Changed description.")).some((error) => error.includes("documentation tags"))).toBe(true);
});

it("deduplicates a copied typedef description prefix only within its named owner", () => {
  const before = "/** Complete prose with details.\n * @typedef {Object} Shape\n */ export const sentinel: number;\n /** Complete prose */ export type Shape = { value: string };";
  const after = "export const sentinel: number;\n /** Complete prose with details. */ export type Shape = { value: string };";
  expect(compare(before, after)).toEqual([]);
  expect(compare(before, after.replace("with details.", "with changes.")).some((error) => error.includes("changed documentation"))).toBe(true);
});

it.each([
  ["property", "export type Shape = {\n /** Member guarantee. */ value: string };", "/** @property value Member guarantee. */ export type Shape = { value: string };", "Shape.value: candidate prose only in parent @property; move it to the member"],
  ["prop", "export type Shape = {\n /** Member guarantee. */ value: string };", "/** @prop value Member guarantee. */ export type Shape = { value: string };", "Shape.value: candidate prose only in parent @prop; move it to the member"],
  ["nested property", "export type Shape = { nested: {\n /** Member guarantee. */ value: string } };", "/** @property nested.value Member guarantee. */ export type Shape = { nested: { value: string } };", "Shape.nested.value: candidate prose only in parent @property; move it to the member"],
  ["type", "/** Value guarantee. */ export const value: string;", "/** @type {string} Value guarantee. */ export const value: string;", "value: candidate prose only in @type; move it to the member"],
  ["overload", "/** Call guarantee. */ export function run(value: string): string;", "/** @overload Call guarantee.\n * @param {string} value\n * @returns {string}\n */ export function run(value: string): string;", "run: candidate prose only in parent @overload; move it to the member"],
  ["overload parameter", "/** @param value Input guarantee. */ export function run(value: string): string;", "/** @overload\n * @param {string} value Input guarantee.\n */ export function run(value: string): string;", "run: candidate prose only in parent @overload; move it to the member"],
])("rejects candidate prose credited only through legacy %s metadata", (_name, before, after, message) => {
  expect(compare(before!, after!)).toContain(message);
});

it("still attributes baseline type prose to its real owner", () => {
  expect(compare("/** @type {string} Value guarantee. */ export const value: string;",
    "/** Value guarantee. */ export const value: string;")).toEqual([]);
});

it("diagnoses parent property prose across merged interface declarations", () => {
  expect(compare("export interface Shape {\n /** Merged value guarantee. */ value: string } export interface Shape { other: number }",
    "export interface Shape { value: string }\n /** @property value Merged value guarantee. */ export interface Shape { other: number }"))
    .toContain("Shape.value: candidate prose only in parent @property; move it to the member");
});
