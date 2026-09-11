/** Edit this policy together with relay/zero_media_relay/policy.py. */
export const ALLOWED_TLS_HOSTS = new Set(["example.com"]);
export const ALLOWED_TLS_SUFFIXES = new Set<string>();

export class TransportTargetError extends Error {
  constructor(hostname: string) {
    super(`The encrypted relay does not permit ${hostname}.`);
    this.name = "TransportTargetError";
  }
}

export function assertAllowedTarget(url: URL): void {
  const hostname = url.hostname;
  if (url.protocol !== "https:" || url.port && url.port !== "443"
    || url.username || url.password || url.hash
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(hostname)
    || /^\d+(?:\.\d+){3}$/.test(hostname)
    || !ALLOWED_TLS_HOSTS.has(hostname)
      && ![...ALLOWED_TLS_SUFFIXES].some(suffix => suffix.startsWith(".") && hostname.endsWith(suffix))) {
    throw new TransportTargetError(hostname);
  }
}

export function normalizeRelayUrl(value: string): string {
  const url = new URL(value);
  if (!["wss:", "ws:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use a WebSocket relay URL without credentials, query or fragment.");
  }
  if (url.protocol === "ws:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("Unencrypted relay connections are limited to local development.");
  }
  if (url.pathname !== "/ws/" && url.pathname !== "/ws") {
    throw new Error("The relay address must end in /ws/.");
  }
  url.pathname = "/ws/";
  return url.toString();
}
