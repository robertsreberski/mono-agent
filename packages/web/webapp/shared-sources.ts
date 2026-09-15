import { fileURLToPath } from "node:url";

// The webapp is installed independently of the framework workspace. Resolve
// only this dependency-free browser contract to its authoritative source, not
// to an incidental ancestor node_modules or a prebuilt contracts barrel.
export const sharedSourceAliases = [{
  find: /^@mono-agent\/agent-contracts\/provider-usage$/,
  replacement: fileURLToPath(new URL("../../agent-contracts/src/provider-usage.ts", import.meta.url)),
}];
