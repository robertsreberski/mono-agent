import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { OPERATOR_CONSOLE_STATIC_DIR } from "../static.js";
import { generateToken } from "./auth.js";
import { handleRequest } from "./handlers.js";
import type {
  OperatorConsoleOptions,
  OperatorConsoleStartResult,
} from "./types.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Start a small loopback HTTP server that reads/writes a settings JSON file
 * and serves the SPA. Refuses non-loopback hosts as a defense in depth.
 */
export async function startOperatorConsole(
  options: OperatorConsoleOptions,
): Promise<OperatorConsoleStartResult> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `startOperatorConsole refuses non-loopback host "${host}"; the console is local-only.`,
    );
  }

  const token = options.token ?? generateToken();
  const fieldGroups = options.fieldGroups ?? [];
  const staticDir = OPERATOR_CONSOLE_STATIC_DIR;
  const port = options.port ?? 0;

  const server = createServer((req, res) => {
    handleRequest(req, res, {
      token,
      configPath: options.configPath,
      fieldGroups,
      staticDir,
      ...(options.observability === undefined ? {} : { observability: options.observability }),
      ...(options.traceability === undefined ? {} : { traceability: options.traceability }),
      ...(options.applyConfigWrite === undefined ? {} : { applyConfigWrite: options.applyConfigWrite }),
      ...(options.log === undefined ? {} : { log: options.log }),
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "handler_threw", reason }));
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host, port }, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;
  options.log?.({ kind: "listening", url });

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolveStop, rejectStop) => {
      server.close((error) => {
        if (error) {
          rejectStop(error);
          return;
        }
        options.log?.({ kind: "stopped" });
        resolveStop();
      });
    });
  };

  return { url, token, stop };
}
