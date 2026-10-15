import { JsonlSessionRepo, MemorySessionRepo, projectContext, createRunDriver } from "@mono-agent/agent-runtime/engine";
import { createSessionRegistry, normalizeDurableSessionsRoot } from "@mono-agent/agent-runtime/engine/sessions.js";
import { OwnedFileDamagedError, publishAtomic, readOwned } from "@mono-agent/agent-runtime/engine/owned-fs.js";

// Compile all three declaration targets through the installed tarball exports.
const memory = new MemorySessionRepo();
const durable = new JsonlSessionRepo({ sessionsRoot: "/fictional/sessions" });
const registry = createSessionRegistry();
void [memory, durable, registry, projectContext, createRunDriver, normalizeDurableSessionsRoot, OwnedFileDamagedError, publishAtomic, readOwned];
