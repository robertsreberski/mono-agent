export const MCP_APP_SECURED_HTML_MAX_BYTES = 2 * 1024 * 1024;

export interface McpAppDocumentCsp {
  readonly connectDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly baseUriDomains?: readonly string[];
}

export interface McpAppDocumentMetadata {
  readonly csp?: McpAppDocumentCsp;
}

const byteSize = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Build the inner document policy from already intersected host grants. */
export const mcpAppContentSecurityPolicy = (metadata: McpAppDocumentMetadata): string => {
  const resources = metadata.csp?.resourceDomains ?? [];
  const connects = metadata.csp?.connectDomains ?? [];
  const frames = metadata.csp?.frameDomains ?? [];
  const bases = metadata.csp?.baseUriDomains ?? [];
  const sources = (items: readonly string[], extras: readonly string[] = []) =>
    [...extras, ...items].join(" ") || "'none'";
  return [
    "default-src 'none'",
    // Server-declared resource origins never become executable-script origins.
    "script-src 'unsafe-inline'",
    `style-src 'unsafe-inline'${resources.length > 0 ? ` ${resources.join(" ")}` : ""}`,
    `img-src ${sources(resources, ["data:", "blob:"])}`,
    `font-src ${sources(resources, ["data:"])}`,
    `media-src ${sources(resources, ["blob:"])}`,
    `connect-src ${sources(connects)}`,
    `frame-src ${sources(frames)}`,
    `base-uri ${sources(bases)}`,
    "form-action 'none'",
    "object-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "navigate-to 'none'",
  ].join("; ");
};

const htmlAttribute = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;");

/** Place the restrictive policy before any server-controlled markup executes. */
export const secureMcpAppHtml = (html: string, metadata: McpAppDocumentMetadata): string => {
  const csp = htmlAttribute(mcpAppContentSecurityPolicy(metadata));
  const secured = `<!doctype html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"></head>${html}`;
  if (byteSize(secured) > MCP_APP_SECURED_HTML_MAX_BYTES) {
    throw new Error("The MCP App resource is too large.");
  }
  return secured;
};
