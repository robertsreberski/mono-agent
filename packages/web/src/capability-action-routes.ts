import type { Express, NextFunction, Request, Response } from "express";
import { parseCapabilityActionInput, parseCapabilityActionSaveInput } from "@mono-agent/channel-operator/client";
import type { WebService } from "./service.js";
import { WebConsoleError } from "./errors.js";

/** Isolated from the console's general error/logging surfaces. No disk config access. */
export function registerCapabilityActionRoutes(app: Express, service: WebService, active: Set<Promise<unknown>>, exactRequestOrigin: (request: Request) => unknown): void {
  const handle = (operation: "read" | "preview" | "save", req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    if (Object.keys(req.query).length !== 0) throw new WebConsoleError("invalid_request", "Invalid capability action.", 400);
    let input;
    try { input = operation === "read" ? undefined : operation === "preview" ? parseCapabilityActionInput(req.body) : parseCapabilityActionSaveInput(req.body); }
    catch { throw new WebConsoleError("invalid_request", "Invalid capability action.", 400); }
    const sourceId = req.params.id;
    if (typeof sourceId !== "string") throw new WebConsoleError("invalid_request", "Invalid agent.", 400);
    const work = service.capabilityActions(sourceId, operation, input);
    active.add(work);
    void work.then((result) => res.json(result)).catch(next).finally(() => active.delete(work));
  };
  app.get("/api/v1/agents/:id/capability-actions", (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    try { exactRequestOrigin(req); handle("read", req, res, next); } catch (error) { next(error); }
  });
  app.post("/api/v1/agents/:id/capability-actions/preview", (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    try { exactRequestOrigin(req); handle("preview", req, res, next); } catch (error) { next(error); }
  });
  app.post("/api/v1/agents/:id/capability-actions/save", (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    try { exactRequestOrigin(req); handle("save", req, res, next); } catch (error) { next(error); }
  });
}
