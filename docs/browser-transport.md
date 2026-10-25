# Browser transport API and lifecycle

The main entry point is [`transport/index.ts`](../transport/index.ts). The example imports this TypeScript module through Vite; a plain browser cannot load the source `.ts` file without that build step. Your UI itself can remain ordinary HTML and JavaScript.

## Request helpers

`requestBytes`, `requestText`, and `requestJson` accept a `FetchLike`, a URL or Request, and request options. Inject `transport.fetch` to keep the request inside browser-owned TLS:

```js
import { requestText } from "./transport/index.ts";

const text = await requestText(transport.fetch, "https://example.com/", {
  signal: viewController.signal,
  timeoutMs: 15_000,
  maxBytes: 256 * 1024,
});
```

The caller owns `transport` and `viewController` in this snippet. The transport can remain open across several requests. Each helper creates and cleans up its own HTTP owner; completing one request never aborts the caller's signal or closes the transport.

| Helper | Result |
| --- | --- |
| `requestBytes(fetch, input, options?)` | `Uint8Array` containing at most `maxBytes` actual bytes. |
| `requestText(fetch, input, options?)` | UTF-8 text decoded from the bounded body. |
| `requestJson(fetch, input, options?)` | An `unknown` JSON value. Requires `application/json` or an `application/*+json` type and valid UTF-8 JSON; validate its shape in the service adapter. |

`HttpRequestOptions` extends `RequestInit` with `timeoutMs` (default 30,000) and `maxBytes` (default 262,144). Both must be positive safe integers; the timeout must also fit the browser timer's 2,147,483,647 ms limit. The deadline includes WASM startup, headers, and body consumption. Invalid limits are rejected before dispatch. The byte limit covers decompressed bytes returned by the transport, independently of Content-Length.

Helpers default to `redirect: "error"` and reject every non-2xx response with `ProtocolError`. Its `status` and optional `retryAfterMs` support explicit retry UI without exposing a remote error body or private URL in the message. `retryAfterMs(headers)` is also exported for raw-response consumers. There is no helper retry loop, including for writes. libcurl's own connection-reuse behavior remains part of the pinned dependency; these helpers do not provide exactly-once delivery.

A caller abort preserves its reason. A helper deadline rejects with a `TimeoutError` DOMException. The helper aborts its owned HTTP request in `finally`, cancels unread or late response bodies, clears its timer, and removes its external abort listener. A transport that ignores cancellation can continue its own work; a helper cannot force arbitrary injected code to stop. Streaming responses and non-2xx body inspection belong at the raw `transport.fetch` layer below.

## A raw bounded request

```js
import { BrowserTlsTransport, readResponseBytes } from "./transport/index.ts";

const transport = new BrowserTlsTransport({
  relayUrl: "ws://127.0.0.1:8080/ws/",
});
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 15_000);

try {
  const response = await transport.fetch("https://example.com/", {
    headers: { accept: "text/html" },
    credentials: "omit",
    redirect: "manual",
    signal: controller.signal,
  });
  const bytes = await readResponseBytes(response, 256 * 1024, controller.signal);
  document.querySelector("pre").textContent = new TextDecoder().decode(bytes);
} finally {
  clearTimeout(deadline);
  controller.abort();
  transport.close();
}
```

For an application with several requests, keep one transport open and close it when its session owner ends. `fetch` is an arrow function, so it can be passed directly to `ImageLoader`, `VideoLoader`, or your own adapter without rebinding `this`.

## Constructor and methods

| API | Behavior |
| --- | --- |
| `new BrowserTlsTransport({ relayUrl })` | Validates the relay URL; initialization is lazy. There is no built-in hosted relay address. |
| `enableCookies?: boolean` | Off by default unless a nonempty `cookieJar` was supplied. Enables the WASM session's own cookie engine. |
| `cookieJar?: string` | Imports a libcurl/Netscape-format jar. Input longer than 65,536 JavaScript characters is rejected. Explicitly disabling cookies while supplying a nonempty jar is an error. |
| `BrowserTlsTransport.supported()` | Checks for basic WASM, WebSocket, and Promise support. It is not a network or certificate test. |
| `initialize()` | Eager initialization when needed. Concurrent callers share one initialization promise per instance. |
| `fetch(input, init?)` | Returns a `Promise<Response>` using the owned WASM session. |
| `exportCookieJar()` | Returns a sensitive plaintext cookie-jar string. There is no automatic persistence. |
| `close()` | Ends the instance permanently and clears its owned session and initial jar reference. Use a new instance for a new session. |

`relayUrl` must end in `/ws/` (a missing final slash is normalized), must not contain credentials, a query, or a fragment, and must use WSS except for `localhost` or `127.0.0.1` development.

libcurl.js 0.7.1 has one global relay-routing setting in each JavaScript realm. Once initialization chooses a relay address, this wrapper rejects another address in that realm even after a session closes. Reload the page to change relays. Separate transport instances can have separate cookie jars while using the same relay.

## Similar to fetch, with explicit differences

The wrapper uses browser `Request`, `Headers`, and `Response` types for familiarity. It is not a drop-in implementation of the entire native Fetch standard.

**Targets:** every request must be HTTPS on port 443 and pass `assertAllowedTarget`. Credentials in the URL, fragments, IP literals, and unapproved hosts are rejected. The default exact hostname is `example.com`; there are no wildcard suffixes. The URL parser canonicalizes inputs before checking the browser policy, while the relay validates the wire authority independently.

**Headers:** explicit `init.headers` are merged back over the constructed Request's headers. Headers such as `Origin` and `Referer` can be meaningful inputs to this independent HTTP stack even when a browser-native request would restrict them. These are inner HTTP headers. They do not change the outer WebSocket's browser-controlled Origin, which the relay checks separately.

**Bodies:** non-GET/HEAD request bodies are buffered with `request.arrayBuffer()`. Streaming upload is not implemented. The transport does not set an aggregate request-body memory budget for callers. The example applies its own 64 KiB UTF-8 body limit before sending; other clients must choose their own bounds.

**Responses:** headers and body are supplied by libcurl.js. The wrapper does not impose an automatic response-size limit, hide cross-origin responses behind CORS filtering, or add an HTTP cache. `readResponseBytes` supplies an explicit cap for consumers that need an in-memory result. A JSON adapter should read a bounded body before `JSON.parse`, instead of calling unbounded `response.json()` on an untrusted result.

**Redirects:** the default is manual. Passing `init.redirect: "follow"` is rejected. An input Request's default `follow` mode is treated as manual unless `init` explicitly overrides it. `redirect: "error"` asks the dependency to reject redirect responses. A client that follows a Location must resolve it, call `assertAllowedTarget` again, set a hop limit, and decide which credentials may cross that boundary. Blindly forwarding Authorization or cookies to a new host is not an acceptable default. See [curl's redirect behavior](https://curl.se/libcurl/c/CURLOPT_FOLLOWLOCATION.html).

**Credentials:** the wrapper maps `credentials: "include"` to the WASM cookie engine; both `omit` and the native default `same-origin` become `omit`. This avoids treating the application's origin as the upstream service's origin. Explicitly supplied Cookie or Authorization headers remain explicit application data; `omit` is not a general-purpose secret scrubber.

## Cookies and session ownership

The WASM jar is separate from the browser's normal cookies. Enabling it does not import an existing Instagram, X, or other website login. JavaScript that holds the transport can export its jar, including sensitive cookie values; native browser HttpOnly isolation does not apply to this application-managed export API.

Prefer a transport per account/session. Keep its reference private to the owning controller. On logout, cancel its requests, close media loaders and release active leases, then call `transport.close()`. Remove any storage copies your application created. Closing the transport clears its own references and library resources; it is not a guarantee of cryptographic memory erasure across a JavaScript engine, browser crash report, or OS swap.

This example never writes a jar to localStorage, sessionStorage, IndexedDB, a server, or the service worker. If a fork adds persistence, that fork must define encryption, key ownership, expiration, cross-tab behavior, and deletion.

## Cancellation and compatibility guards

Cancellation is checked before initialization, after initialization, after buffering the body, and immediately before the library allocates a request. A caller can stop waiting for shared WASM initialization or body preparation immediately; another caller can continue using that initialization. The final allocation check matters because libcurl.js 0.7.1 awaits option preparation before installing its own abort listener. An abort during that gap could otherwise miss the listener and allocate a request after its owner has disappeared.

The wrapper installs a guard on the owned session's `stream_response` method, rather than replacing a shared global prototype. It also suppresses a late headers callback after cancellation or closure: the dependency can clear its HTTP handle before deferred native removal, and reading response information in that gap is unsafe. The completion callback remains intact for native cleanup. If the allocation boundary is missing or cannot be guarded, initialization fails and closes the new session.

Closing a libcurl.js 0.7.1 session while a response is active can leave its polling interval alive. `closeLibcurlSessionSafely()` clears the pinned dependency's `event_loop` interval before calling its close method. These two accommodations depend on the pinned version's internals. A dependency upgrade must recheck them against actual library source and run the lifecycle tests; do not simply remove them because the public API still compiles.

The session's connection settings are `set_connections(12, 8, 4)`, matching the dependency's maximum-connections, cache-size, and per-host arguments. These limits concern the session's connection pool; they do not bound all JavaScript request objects or all media caches in an application.

`readResponseBytes()` counts actual returned bytes, cancels its reader on abort or completion, and releases the stream lock without waiting for a source's asynchronous cancellation hook. With the pinned library, aborting the owning request is also needed to promptly release the underlying HTTP handle. Keep that abort in a `finally` block even if the body was fully read, or use a request helper that owns this cleanup.
