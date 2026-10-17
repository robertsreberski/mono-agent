import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const { compareGraphs } = await import(new URL("../../scripts/compare-public-declarations.mjs", import.meta.url).href) as {
  compareGraphs(baseline: string, candidate: string, entries: { key: string; types: string }[]): {
    entry: string; exports: number; errors: string[];
  }[];
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function compare(before: string, after: string) {
  const directory = mkdtempSync(fileURLToPath(new URL("../../node_modules/declaration-test-", import.meta.url)));
  directories.push(directory);
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
  const directory = mkdtempSync(join(turn, "node_modules/declaration-test-"));
  directories.push(directory);
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
  const directory = mkdtempSync(join(turn, "node_modules/declaration-test-"));
  directories.push(directory);
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
