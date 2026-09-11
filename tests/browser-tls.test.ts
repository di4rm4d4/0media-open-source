import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserTlsHeaders,
  BrowserTlsTransport,
  closeLibcurlSessionSafely,
} from "../transport/browser-tls";

const mockedCurl = vi.hoisted(() => ({
  load: vi.fn(), createSession: vi.fn(), setWebsocket: vi.fn(),
}));
vi.mock("libcurl.js/bundled", () => ({ libcurl: {
  load_wasm: mockedCurl.load,
  set_websocket: mockedCurl.setWebsocket,
  HTTPSession: function (options: unknown) { return mockedCurl.createSession(options); },
} }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class FakeCurlSession {
  base_url = "";
  closed = 0;
  event_loop: ReturnType<typeof setInterval> | null = null;
  fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  requests: Array<{ owner: FakeCurlSession; url: string; signal?: AbortSignal | null }> = [];
  optionsGate?: Promise<void>;
  optionsStarted = deferred();
  set_connections = vi.fn();
  export_cookies() { return "synthetic"; }
  close() { this.closed += 1; }

  // Deliberately model the pinned bug: this synchronous boundary would create
  // a request even if an abort fired during the awaited options preparation.
  stream_response(url: string, _headers: unknown, _end: unknown, signal?: AbortSignal | null) {
    this.requests.push({ owner: this, url, signal });
    return this.requests.length;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    this.fetchCalls.push({ input, init });
    this.optionsStarted.resolve();
    await this.optionsGate;
    this.stream_response(String(input), () => undefined, () => undefined, init?.signal);
    return new Response("synthetic", { headers: { "content-type": "text/plain" } });
  }
}

beforeEach(() => {
  mockedCurl.load.mockReset().mockResolvedValue(undefined);
  mockedCurl.createSession.mockReset().mockImplementation(() => new FakeCurlSession());
  mockedCurl.setWebsocket.mockReset();
  vi.spyOn(BrowserTlsTransport, "supported").mockReturnValue(true);
});

describe("browser-owned TLS transport boundary", () => {
  it("defaults to manual redirects and a cookie-disabled session", async () => {
    const session = new FakeCurlSession();
    mockedCurl.createSession.mockReturnValue(session);
    const transport = new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/" });
    await transport.fetch("https://example.com/");
    expect(mockedCurl.createSession).toHaveBeenCalledWith({ enable_cookies: false });
    expect(session.fetchCalls[0].init).toMatchObject({ redirect: "manual", credentials: "omit" });
    transport.close();
  });

  it("requires an explicit include request to use the enabled cookie engine", async () => {
    const session = new FakeCurlSession();
    mockedCurl.createSession.mockReturnValue(session);
    const transport = new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/", enableCookies: true });
    await transport.fetch("https://example.com/", { credentials: "same-origin" });
    await transport.fetch("https://example.com/", { credentials: "include" });
    expect(mockedCurl.createSession).toHaveBeenCalledWith({ enable_cookies: true });
    expect(session.fetchCalls.map(call => call.init?.credentials)).toEqual(["omit", "include"]);
    transport.close();
  });

  it("rejects automatic redirects and unapproved destinations before library initialization", async () => {
    const transport = new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/" });
    await expect(transport.fetch("https://example.com/", { redirect: "follow" })).rejects.toThrow(/redirects explicitly/);
    await expect(transport.fetch("https://other.example.com/")).rejects.toThrow(/does not permit/);
    expect(mockedCurl.load).not.toHaveBeenCalled();
    transport.close();
  });

  it("rejects conflicting or oversized cookie import options", () => {
    expect(() => new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/", enableCookies: false, cookieJar: "synthetic" })).toThrow(/requires enableCookies/);
    expect(() => new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/", cookieJar: "x".repeat(65537) })).toThrow(/64 KiB/);
  });

  it("keeps the global relay address fixed after an owned session closes", async () => {
    const first = new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/" });
    await first.initialize();
    first.close();
    const second = new BrowserTlsTransport({ relayUrl: "wss://relay.example.org/ws/" });
    await expect(second.initialize()).rejects.toThrow(/one relay address/);
    expect(mockedCurl.setWebsocket).toHaveBeenCalledExactlyOnceWith("ws://127.0.0.1:8080/ws/");
    expect(mockedCurl.createSession).toHaveBeenCalledOnce();
    second.close();
  });

  it("preserves explicit protocol headers stripped by a native Request while retaining generated body headers", () => {
    // Model Chromium's native Request result: browser-controlled headers are
    // absent. The WASM stack must receive the original explicit protocol inputs.
    const request = new Request("https://example.com/accounts/login/", { method: "POST", body: new URLSearchParams({ test: "offline" }), headers: { accept: "text/html" } });
    const headers = browserTlsHeaders(request, { origin: "https://example.com", referer: "https://example.com/accounts/login/", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" });
    expect(headers.get("origin")).toBe("https://example.com");
    expect(headers.get("referer")).toBe("https://example.com/accounts/login/");
    expect(headers.get("sec-fetch-dest")).toBe("document");
    expect(headers.get("sec-fetch-mode")).toBe("navigate");
    expect(headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(headers.get("accept")).toBe("text/html");
    expect(browserTlsHeaders(request).get("origin")).toBeNull();
  });

  it("stops libcurl's active polling loop before closing its WASM session", () => {
    const calls: string[] = [];
    const clearIntervalSpy = vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation(() => calls.push("clear interval"));
    const session = {
      event_loop: 731,
      close: vi.fn(() => calls.push("close session")),
    } as unknown as Parameters<typeof closeLibcurlSessionSafely>[0];

    closeLibcurlSessionSafely(session);

    expect(clearIntervalSpy).toHaveBeenCalledWith(731);
    expect((session as unknown as { event_loop: number | null }).event_loop).toBeNull();
    expect(calls).toEqual(["clear interval", "close session"]);
  });

  it("rejects an already aborted request without initializing or allocating a session", async () => {
    const transport = new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/" });
    const controller = new AbortController();
    controller.abort();
    await expect(transport.fetch("https://example.com/", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mockedCurl.load).not.toHaveBeenCalled();
    expect(mockedCurl.createSession).not.toHaveBeenCalled();
    transport.close();
  });

  it("rechecks abort after initialization without dispatching to libcurl", async () => {
    const loading = deferred();
    mockedCurl.load.mockReturnValue(loading.promise);
    const session = new FakeCurlSession();
    mockedCurl.createSession.mockReturnValue(session);
    const transport = new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/" });
    const controller = new AbortController();
    const rejected = expect(transport.fetch("https://example.com/", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mockedCurl.load).toHaveBeenCalledOnce());
    controller.abort();
    loading.resolve();
    await rejected;
    expect(session.fetchCalls).toHaveLength(0);
    expect(session.requests).toHaveLength(0);
    // Request cancellation does not close a shared initialized TLS session.
    await transport.fetch("https://example.com/");
    expect(session.requests).toHaveLength(1);
    transport.close();
    expect(session.closed).toBe(1);
  });

  it.each(["abort", "close"])("rechecks %s after browser request body preparation", async action => {
    const prepared = deferred<ArrayBuffer>();
    const body = vi.spyOn(Request.prototype, "arrayBuffer").mockReturnValueOnce(prepared.promise);
    const session = new FakeCurlSession();
    mockedCurl.createSession.mockReturnValue(session);
    const transport = new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/" });
    await transport.initialize();
    const controller = new AbortController();
    const pending = transport.fetch("https://example.com/", { method: "POST", body: "synthetic", signal: controller.signal });
    const rejected = action === "abort" ? expect(pending).rejects.toMatchObject({ name: "AbortError" })
      : expect(pending).rejects.toThrow("This browser TLS session is closed.");
    await vi.waitFor(() => expect(body).toHaveBeenCalledOnce());
    if (action === "abort") controller.abort();
    else transport.close();
    prepared.resolve(new ArrayBuffer(0));
    await rejected;
    expect(session.fetchCalls).toHaveLength(0);
    expect(session.requests).toHaveLength(0);
    transport.close();
    expect(session.closed).toBe(1);
  });

  it.each(["abort", "close"])("blocks %s during libcurl options preparation at the synchronous allocation boundary", async action => {
    const options = deferred();
    const session = new FakeCurlSession();
    session.optionsGate = options.promise;
    mockedCurl.createSession.mockReturnValue(session);
    const transport = new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/" });
    const controller = new AbortController();
    const onAbort = vi.fn();
    controller.signal.addEventListener("abort", onAbort);
    const pending = transport.fetch("https://example.com/", { signal: controller.signal });
    const rejected = action === "abort" ? expect(pending).rejects.toMatchObject({ name: "AbortError" })
      : expect(pending).rejects.toThrow("This browser TLS session is closed.");
    await session.optionsStarted.promise;
    if (action === "abort") controller.abort();
    else transport.close();
    options.resolve();
    await rejected;
    expect(session.fetchCalls).toHaveLength(1);
    expect(session.requests).toHaveLength(0);
    expect(onAbort).toHaveBeenCalledTimes(action === "abort" ? 1 : 0); // No replayed abort event.
    transport.close();
    expect(session.closed).toBe(1);
  });

  it("guards only the owned session and preserves normal callbacks, receiver and request options", async () => {
    const prototypeBoundary = FakeCurlSession.prototype.stream_response;
    const session = new FakeCurlSession();
    const unrelated = new FakeCurlSession();
    mockedCurl.createSession.mockReturnValue(session);
    const transport = new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/", cookieJar: "synthetic" });
    const controller = new AbortController();
    const response = await transport.fetch("https://example.com/", { signal: controller.signal, credentials: "omit", redirect: "error", headers: { accept: "video/mp4" } });
    expect(await response.text()).toBe("synthetic");
    expect(Object.hasOwn(session, "stream_response")).toBe(true);
    expect(FakeCurlSession.prototype.stream_response).toBe(prototypeBoundary);
    expect(unrelated.stream_response).toBe(prototypeBoundary);
    expect(mockedCurl.createSession).toHaveBeenCalledWith({ enable_cookies: true, cookie_jar: "synthetic" });
    expect(session.set_connections).toHaveBeenCalledWith(12, 8, 4);
    expect(session.requests).toHaveLength(1);
    expect(session.requests[0].owner).toBe(session);
    expect(session.requests[0].signal?.aborted).toBe(false);
    expect(session.fetchCalls[0].init).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(new Headers(session.fetchCalls[0].init?.headers).get("accept")).toBe("video/mp4");
    transport.close();
    expect(session.closed).toBe(1);
  });

  it.each(["missing", "uninstallable"])("fails closed and cleans newly allocated WASM when the pinned boundary is %s", async mode => {
    const calls: string[] = [];
    const session = new FakeCurlSession();
    session.event_loop = 731 as unknown as ReturnType<typeof setInterval>;
    session.close = () => { session.closed += 1; calls.push("close"); };
    if (mode === "missing") Object.defineProperty(session, "stream_response", { value: undefined });
    else Object.preventExtensions(session);
    mockedCurl.createSession.mockReturnValue(session);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => calls.push("clear"));
    const transport = new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/", cookieJar: "synthetic" });
    await expect(transport.fetch("https://example.com/")).rejects.toThrow("The encrypted transport does not support safe request cancellation.");
    expect(calls).toEqual(["clear", "close"]);
    expect(session.event_loop).toBeNull();
    expect(session.requests).toHaveLength(0);
    expect(session.fetchCalls).toHaveLength(0);
    expect(session.set_connections).not.toHaveBeenCalled();
    expect(transport.exportCookieJar()).toBe("");
    transport.close();
    expect(session.closed).toBe(1);
  });

  it("cleans a session allocated after its owner closes during initialization", async () => {
    const loading = deferred();
    mockedCurl.load.mockReturnValue(loading.promise);
    const session = new FakeCurlSession();
    mockedCurl.createSession.mockReturnValue(session);
    const transport = new BrowserTlsTransport({ relayUrl: "ws://127.0.0.1:8080/ws/" });
    const rejected = expect(transport.fetch("https://example.com/")).rejects.toThrow("This browser TLS session is closed.");
    await vi.waitFor(() => expect(mockedCurl.load).toHaveBeenCalledOnce());
    transport.close();
    loading.resolve();
    await rejected;
    expect(session.closed).toBe(1);
    expect(session.requests).toHaveLength(0);
    expect(transport.exportCookieJar()).toBe("");
  });
});
