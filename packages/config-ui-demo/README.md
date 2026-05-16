# @worklab-ai/config-ui-demo

Private local demo host for the Mono Agent config UI bridge.

## What it does

Boots `@worklab-ai/config-ui` against `<cwd>/mono-agent.config.json` on a free loopback port and prints the URL + bearer token. Use it to verify the config UI end-to-end without touching the Telegram demo.

## Run

```bash
corepack enable
pnpm install
pnpm run build
node packages/config-ui-demo/dist/cli.js
# config-ui: http://127.0.0.1:<port>/?t=<token>
# config:    /path/to/cwd/mono-agent.config.json
```

Press `Ctrl+C` to stop. Bot tokens, max-turns changes, etc. are persisted to `mono-agent.config.json` in the directory you ran the CLI from.

## Reuse

```ts
import { startDemoBridge } from "@worklab-ai/config-ui-demo";

const bridge = await startDemoBridge({ cwd: "/path/to/project" });
console.log(bridge.url, bridge.token, bridge.configPath);
await bridge.stop();
```

`startDemoBridge` is a 10-line wrapper around `@worklab-ai/config-ui` that fixes a sensible default config path. Hosts that want to register custom field groups should call `startConfigUiBridge` directly.
