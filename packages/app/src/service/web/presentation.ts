import { networkInterfaces } from "node:os";

import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, DEFAULT_WEB_THEME, WEB_THEMES } from "./web-service-definition.js";
import type { CommandResult, TailscaleServeResult } from "./types.js";
import * as ui from "../../cli/ui.js";

export function renderWebHelp(): string {
  return [
    "mono-agent web — always-on multi-agent web console",
    "",
    "  mono-agent web",
    "  mono-agent web start [--host <addr> | --loopback] [--port <n>] [--theme <name>] [--name <label>] [--share-tailnet]",
    "  mono-agent web restart [--host <addr> | --loopback] [--port <n>] [--theme <name>] [--name <label>] [--share-tailnet]",
    "  mono-agent web stop | status [--json]",
    "  mono-agent web logs [--follow|-f] [--lines <n>]",
    "  mono-agent web run [--host <addr> | --loopback] [--port <n>] [--theme <name>] [--name <label>]",
    "  mono-agent web reset --all --yes",
    "",
    `Default bind: ${DEFAULT_WEB_HOST}:${String(DEFAULT_WEB_PORT)} (loopback listener; no app login).`,
    "--host <addr> binds wider (for example 0.0.0.0 for the LAN).",
    "macOS start/restart publish an owned Tailscale Serve HTTPS route only with --share-tailnet;",
    "an existing mono-agent-owned route is re-verified on restart. Linux HTTPS routes are externally managed.",
    `Themes: ${WEB_THEMES.join(", ")} (default: ${DEFAULT_WEB_THEME}).`,
    "--name sets the installed PWA label, browser tab title, and rail brand; --name - restores the hostname default.",
    "",
  ].join("\n");
}

/** Structured inspection guidance for a failure whose cleanup result is uncertain. */
export function sharingAttemptDescription(result: Extract<TailscaleServeResult, { kind: "unavailable" }>): string {
  const port = result.attempted?.httpsPort;
  const target = result.attempted?.proxyTarget;
  if (port === undefined) return "";
  return ` (attempted HTTPS port ${String(port)}${target === undefined ? "" : ` -> ${target}`})`;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function printWebUrls(
  stdout: { write(text: string): void },
  serverUrl: string,
  port: number,
  host: string,
  discover?: () => readonly string[],
): void {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    const ipv6Bind = host === "::" || host === "[::]";
    stdout.write(`Local      → http://${ipv6Bind ? "[::1]" : "127.0.0.1"}:${String(port)}/\n`);
    for (const address of advertisableNetworkAddresses((discover ?? discoverNetworkAddresses)())
      .filter((candidate) => candidate.includes(":") === ipv6Bind)) {
      const label = isTailscaleAddress(address) ? "Tailscale" : "LAN";
      stdout.write(`${label.padEnd(10)} → http://${urlHost(address)}:${String(port)}/\n`);
    }
    return;
  }
  stdout.write(`Web        → ${serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`}\n`);
}

function isTailscaleAddress(address: string): boolean {
  const normalized = normalizeNetworkAddress(address);
  if (normalized.split("%", 1)[0]?.startsWith("fd7a:115c:a1e0:")) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\./u.exec(normalized);
  if (match?.[1] !== "100" || match[2] === undefined) return false;
  const second = Number(match[2]);
  return second >= 64 && second <= 127;
}

function discoverNetworkAddresses(): readonly string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && (entry.family === "IPv4" || entry.family === "IPv6")) addresses.push(entry.address);
    }
  }
  return advertisableNetworkAddresses(addresses);
}

function advertisableNetworkAddresses(addresses: readonly string[]): readonly string[] {
  return [...new Set(addresses.map(normalizeNetworkAddress).filter(isAdvertisableNetworkAddress))]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }));
}

function normalizeNetworkAddress(address: string): string {
  const unbracketed = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  return unbracketed.toLowerCase();
}

function isAdvertisableNetworkAddress(address: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address);
  if (ipv4 !== null) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((value) => value > 255)) return false;
    const [first = -1, second = -1] = octets;
    return first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254);
  }
  const [literal = ""] = address.split("%", 2);
  const firstHextet = Number.parseInt(literal.split(":", 1)[0] ?? "", 16);
  if (!Number.isFinite(firstHextet)) return false;
  // Browser URL implementations do not consistently support IPv6 zone IDs,
  // so even scoped link-local literals are not advertised as concrete links.
  return (firstHextet & 0xfe00) === 0xfc00;
}

export function urlHost(host: string): string {
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return normalized.includes(":") ? `[${normalized.replace("%", "%25")}]` : normalized;
}

export function commandDetail(result: CommandResult): string {
  return (result.stderr || result.stdout).trim();
}

export function writeCommandDetail(stream: { write(text: string): void }, result: CommandResult): void {
  const detail = commandDetail(result);
  if (detail.length > 0) stream.write(ui.style.dim(detail) + "\n");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
