import { readFileSync } from "node:fs";

// Keep this module dependency-free and parseable by unsupported Node releases.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  engines: { node: string };
};
export const requiredNode = manifest.engines.node;
export const minimumNode = requiredNode.replace(/^>=/, "");

export function supportedNode(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const actual = version.split(".").map(Number);
  const minimum = minimumNode.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (actual[i]! > minimum[i]!) return true;
    if (actual[i]! < minimum[i]!) return false;
  }
  return true;
}

export function nodeVersionFailure(version = process.versions.node): string {
  return `mono-agent requires Node.js ${requiredNode}; found ${version}.
Select a supported Node before retrying (choose one alternative):
  nvm install ${minimumNode} && nvm use ${minimumNode}
  fnm install ${minimumNode} && fnm use ${minimumNode}
  volta install node@${minimumNode}
  Official installer: https://nodejs.org/en/download
`;
}

export function guardNodeVersion(): boolean {
  if (supportedNode(process.versions.node)) return true;
  process.stderr.write(nodeVersionFailure());
  process.exitCode = 1;
  return false;
}
