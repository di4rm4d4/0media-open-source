import type { FetchLike } from "./types";
import { assertAllowedTarget, normalizeRelayUrl } from "./policy";

type LibcurlSession = import("libcurl.js/bundled").LibcurlSession;
type PinnedStreamResponse = (
  this: LibcurlSession,
  url: string,
  headersCallback: unknown,
  endCallback: unknown,
  signal?: AbortSignal | null,
) => unknown;
type ManagedLibcurlSession = LibcurlSession & {
  event_loop?: ReturnType<typeof setInterval> | null;
  stream_response?: PinnedStreamResponse;
};

// libcurl.js owns a single WebSocket routing setting per JavaScript realm.
let configuredRelay: string | undefined;

export interface BrowserTlsTransportOptions {
  relayUrl: string;
  enableCookies?: boolean;
  cookieJar?: string;
}

export interface BrowserTransport {
  readonly label: string;
  readonly fetch: FetchLike;
  exportCookieJar(): string;
  close(): void;
}

/** Native Request removes headers such as Origin/Referer/Sec-Fetch-*. They are
 * legitimate protocol inputs for our own TLS stack, not a native fetch call. */
export function browserTlsHeaders(request: Request, explicit?: HeadersInit): Headers {
  const headers = new Headers(request.headers);
  if (explicit) for (const [name, value] of new Headers(explicit)) headers.set(name, value);
  return headers;
}

/**
 * libcurl.js 0.7.1 leaves its polling interval running when a session is
 * closed with a response still in flight. Stop that internal loop before the
 * library frees its WASM session pointer so navigation cannot leave a crashing
 * timer behind. Remove this compatibility guard when the pinned dependency
 * clears the interval itself.
 */
export function closeLibcurlSessionSafely(session: LibcurlSession): void {
  const managedSession = session as ManagedLibcurlSession;
  if (managedSession.event_loop != null) {
    clearInterval(managedSession.event_loop);
    managedSession.event_loop = null;
  }
  session.close();
}

/** libcurl.js 0.7.1 awaits options preparation before installing its abort
 * listener, but does not check an already-aborted signal there. Guard the last
 * synchronous boundary before request allocation on this owned session only.
 * Remove when the pinned library provides the same guarantee itself. */
function installLibcurlAbortGuard(session: LibcurlSession, isClosed: () => boolean): void {
  const managedSession = session as ManagedLibcurlSession;
  const original = managedSession.stream_response;
  if (typeof original !== "function") {
    throw new Error("The encrypted transport does not support safe request cancellation.");
  }
  const guarded: PinnedStreamResponse = function (url, headersCallback, endCallback, signal) {
    if (isClosed()) throw new Error("This browser TLS session is closed.");
    signal?.throwIfAborted();
    return original.call(this, url, headersCallback, endCallback, signal);
  };
  try {
    Object.defineProperty(managedSession, "stream_response", { value: guarded, configurable: true, writable: true });
  } catch {
    throw new Error("The encrypted transport does not support safe request cancellation.");
  }
}

export class BrowserTlsTransport implements BrowserTransport {
  readonly label = "WASM TLS · opaque relay";
  private readonly relayUrl: string;
  private initialCookieJar?: string;
  private readonly enableCookies: boolean;
  private session?: LibcurlSession;
  private initializing?: Promise<void>;
  private closed = false;

  constructor(options: BrowserTlsTransportOptions) {
    this.relayUrl = normalizeRelayUrl(options.relayUrl);
    if (options.cookieJar && options.cookieJar.length > 65536) throw new Error("Cookie jar exceeds 64 KiB.");
    this.enableCookies = options.enableCookies ?? Boolean(options.cookieJar);
    if (options.cookieJar && !this.enableCookies) throw new Error("Importing cookies requires enableCookies.");
    this.initialCookieJar = options.cookieJar;
  }

  static supported(): boolean {
    return (
      typeof WebAssembly === "object" &&
      typeof WebSocket === "function" &&
      typeof Promise === "function"
    );
  }

  async initialize(): Promise<void> {
    if (this.closed) throw new Error("This browser TLS session is closed.");
    if (this.session) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      if (!BrowserTlsTransport.supported()) {
        throw new Error("This browser cannot run the encrypted WASM transport.");
      }

      const { libcurl } = await import("libcurl.js/bundled");
      if (configuredRelay && configuredRelay !== this.relayUrl) {
        throw new Error("A page can use only one relay address. Reload before changing it.");
      }
      configuredRelay = this.relayUrl;
      libcurl.transport = "wsproxy";
      libcurl.set_websocket(this.relayUrl);
      await libcurl.load_wasm();
      libcurl.logger = () => undefined;
      libcurl.stdout = () => undefined;
      libcurl.stderr = () => undefined;

      const session = new libcurl.HTTPSession({
        enable_cookies: this.enableCookies,
        ...(this.initialCookieJar ? { cookie_jar: this.initialCookieJar } : {}),
      });
      this.initialCookieJar = undefined;
      try {
        installLibcurlAbortGuard(session, () => this.closed);
        session.set_connections(12, 8, 4);
        if (this.closed) throw new Error("This browser TLS session is closed.");
        this.session = session;
      } catch (error) {
        // Even an incompatible pinned boundary owns newly allocated WASM and
        // cookie resources. Never publish it or fall back to unguarded fetch.
        try { closeLibcurlSessionSafely(session); }
        finally { throw error; }
      }
    })();

    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  readonly fetch: FetchLike = async (input, init) => {
    if (init?.redirect === "follow") throw new Error("Handle redirects explicitly and validate each target.");
    const request = new Request(input, init);
    const url = new URL(request.url);
    assertAllowedTarget(url);
    request.signal.throwIfAborted();
    await this.initialize();
    request.signal.throwIfAborted();
    const session = this.session;
    if (this.closed || !session) throw new Error("This browser TLS session is closed.");

    // Rebuild RequestInit rather than forwarding the Request object: libcurl.js
    // needs the request URL in order to establish its own TLS connection.
    const headers = browserTlsHeaders(request, init?.headers);
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
    request.signal.throwIfAborted();
    if (this.closed || this.session !== session) throw new Error("This browser TLS session is closed.");

    return session.fetch(url, {
      method: request.method,
      headers,
      body,
      redirect: init?.redirect ?? (request.redirect === "error" ? "error" : "manual"),
      signal: request.signal,
      credentials: request.credentials === "include" ? "include" : "omit",
    });
  };

  exportCookieJar(): string {
    if (!this.session) return this.initialCookieJar ?? "";
    return this.session.export_cookies();
  }

  close(): void {
    this.closed = true;
    if (this.session) closeLibcurlSessionSafely(this.session);
    this.session = undefined;
    this.initialCookieJar = undefined;
  }
}
