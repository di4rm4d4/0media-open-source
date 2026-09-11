import { ALLOWED_TLS_HOSTS, ALLOWED_TLS_SUFFIXES } from "../transport/policy";

export const EDGE_RELAY_HOSTS = [...ALLOWED_TLS_HOSTS];
export const EDGE_RELAY_SUFFIXES = [...ALLOWED_TLS_SUFFIXES];

export const RELAY_HTTP_HOST = "relay.example.org";
export const RELAY_BROWSER_ORIGIN = "https://client.example.org";

const allowedHosts = new Set<string>(EDGE_RELAY_HOSTS);
const canonicalHostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface RelayTarget {
  readonly host: string;
  readonly port: 443;
}

/** Parse the single URL shape accepted by the edge TCP relay. */
export function parseRelayTarget(url: URL): RelayTarget | null {
  if (
    url.protocol !== "https:" ||
    url.hostname !== RELAY_HTTP_HOST ||
    (url.port !== "" && url.port !== "443") ||
    url.search !== "" ||
    url.pathname.length > 264 ||
    !url.pathname.startsWith("/ws/")
  ) {
    return null;
  }

  const encodedAuthority = url.pathname.slice(4);
  if (!encodedAuthority || encodedAuthority.includes("/")) return null;

  let authority: string;
  try {
    authority = decodeURIComponent(encodedAuthority);
  } catch {
    return null;
  }

  // A remaining percent sign would make a second decoding pass meaningful.
  // Reject it so every layer has exactly one interpretation of the target.
  if (
    !authority ||
    authority.length > 260 ||
    authority.includes("%") ||
    authority.includes("/") ||
    authority.includes("\\") ||
    authority.includes("@") ||
    authority.includes("?") ||
    authority.includes("#") ||
    /\s/.test(authority)
  ) {
    return null;
  }

  const separator = authority.lastIndexOf(":");
  if (separator <= 0 || separator !== authority.indexOf(":")) return null;
  const host = authority.slice(0, separator);
  const port = authority.slice(separator + 1);
  if (
    port !== "443" ||
    host.endsWith(".") ||
    !canonicalHostname.test(host) ||
    (!allowedHosts.has(host) && !EDGE_RELAY_SUFFIXES.some((suffix) => host.endsWith(suffix)))
  ) {
    return null;
  }

  return { host, port: 443 };
}

export function acceptsBrowserOrigin(request: Request): boolean {
  return request.headers.get("Origin") === RELAY_BROWSER_ORIGIN;
}

export function selectsBinaryProtocol(request: Request): boolean {
  const protocols = request.headers.get("Sec-WebSocket-Protocol");
  return protocols !== null && protocols.split(",").some((value) => value.trim() === "binary");
}
