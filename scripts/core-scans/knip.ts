// Source-only scan: no build products or temporary package tsconfigs required.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const turnHost = (file: string) => [resolve(root, `packages/turn/src/host/${file}.ts`)];
const paths = {
  "@mono-agent/turn/host": turnHost("index"),
  "@mono-agent/turn/host/config": turnHost("config"),
  "@mono-agent/turn/host/types": turnHost("types"),
  "@mono-agent/turn/host/sandbox": turnHost("sandbox"),
};

export default {
  // These by-path fixture declarations describe their .mjs companions; they
  // are not independent runtime exports. Keep the .mjs exports analyzed.
  ignoreIssues: {
    "packages/conversation/src/__tests__/fixtures/canonical-v5-fixture.d.mts": ["exports"],
    "packages/conversation/src/__tests__/fixtures/managed-native-switch-fixture.d.mts": ["exports"],
  },
  workspaces: {
    ".": { paths },
    "packages/*": { paths },
    "extras/*": { paths },
    "packages/contracts": {
      paths,
      project: ["src/**/*.{ts,mjs,mts}!", "!src/**/__tests__/**!"],
    },
    "packages/config": {
      paths,
      project: ["src/**/*.{ts,mjs,mts}!", "!src/**/__tests__/**!"],
    },
    "packages/turn": {
      paths,
      entry: [
        "src/index.js!",
        "src/host/{index,config,types,sandbox}.ts!",
        "src/host/srt-embed-runner.mjs!",
        "src/engine/__tests__/fixtures/regenerate-projection-goldens.mjs",
      ],
      project: ["src/**/*.{js,mjs,ts,mts}!", "!src/**/__tests__/**!"],
      ignoreDependencies: ["@vscode/ripgrep"],
    },
    "packages/conversation": {
      paths,
      entry: [
        "src/index.ts!",
        "src/tool-history-writer-worker.ts!",
        "src/__tests__/fixtures/canonical-v5-fixture.d.mts",
        "src/__tests__/fixtures/managed-native-switch-fixture.d.mts",
      ],
      project: ["src/**/*.{ts,mjs,mts}!", "!src/**/__tests__/**!"],
    },
    "packages/app": {
      paths,
      entry: [
        "src/{index,cli}.ts!",
        "scripts/smoke-subagent-stop.mjs",
        "scripts/smoke-subagent-steer.mjs",
        "src/__tests__/fixtures/managed-subagent-proof.mjs",
        "src/__tests__/fixtures/subagent-observer-srt.mjs",
        "src/__tests__/fixtures/worker-maintenance-smoke.mjs",
      ],
      project: ["src/**/*.{ts,mjs,mts}!", "!src/**/__tests__/**!", "scripts/*.mjs"],
    },
  },
};
