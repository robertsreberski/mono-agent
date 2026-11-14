import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { LEGACY_CREDENTIAL_CARDS, CredentialSetupError, parseCredentialSaveRequest, parseCredentialRequest, parseCredentialSnapshot, parseCredentialSaved, type CredentialSetupService } from "../credential-setup.js";

/** Terminal, isolated parsing/error boundary: request bytes and exception prose never reach diagnostics. */
export function registerCredentialRoutes(app: Express, basePath: string, service: CredentialSetupService | undefined): void {
  const path = `${basePath}/v1/credentials`;
  app.use(path, (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    if (Object.keys(req.query).length || (req.headers.origin !== undefined && req.headers.origin !== `${req.protocol}://${req.get("host")}`)) { res.status(400).json({ error: { code: "credential_invalid", message: "Invalid credential request." } }); return; }
    next();
  });
  const handler = (operation: "read" | "save" | "retry") => (req: Request, res: Response): void => {
    if (service === undefined) { res.status(501).json({ error: { code: "credential_unavailable", message: "Credential entry is unavailable." } }); return; }
    let work;
    try { work = operation === "read" ? service.read() : operation === "save" ? service.save(parseCredentialSaveRequest(req.body)) : service.retry(parseCredentialRequest(req.body)); }
    catch { res.status(400).json({ error: { code: "credential_invalid", message: "Invalid credential request." } }); return; }
    finally { req.body = undefined; }
    void work.then((result) => {
      if (operation !== "read") { res.json(parseCredentialSaved(result)); return; }
      const snapshot = parseCredentialSnapshot(result);
      res.vary("X-Mono-Agent-Credential-Inventory");
      // Older v1 proxies strictly decode exactly the original three cards.
      res.json(req.get("X-Mono-Agent-Credential-Inventory") === "extended" ? snapshot : { ...snapshot, cards: snapshot.cards.filter((card) => (LEGACY_CREDENTIAL_CARDS as readonly string[]).includes(card.id)) });
    }).catch((error: unknown) => {
      const code = error instanceof CredentialSetupError && ["credential_invalid", "credential_conflict", "credential_unavailable", "credential_outcome_unknown"].includes(error.code) ? error.code : "credential_outcome_unknown";
      res.status(code === "credential_invalid" ? 400 : code === "credential_outcome_unknown" ? 503 : 409).json({ error: { code, message: "Credential operation could not be completed. Refresh status; never replay an unconfirmed save automatically." } });
    });
  };
  app.get(path, handler("read"));
  for (const operation of ["save", "retry"] as const) app.post(`${path}/${operation}`, (req: Request, res: Response, next: NextFunction) => {
    if (!req.is("application/json") || (req.headers["content-encoding"] !== undefined && req.headers["content-encoding"] !== "identity")) { res.status(415).json({ error: { code: "credential_invalid", message: "Use uncompressed JSON." } }); return; }
    next();
  }, express.json({ limit: "16kb", strict: true, inflate: false }), handler(operation), (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status((error as { status?: number })?.status === 413 ? 413 : 400).json({ error: { code: "credential_invalid", message: "Invalid credential request." } });
  });
  app.use(path, (_req, res) => { res.status(404).json({ error: { code: "credential_invalid", message: "Unknown credential operation." } }); });
}
