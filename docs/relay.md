# Relay protocol and implementation

The primary backend is the Python ASGI application in [`relay/zero_media_relay/`](../relay/zero_media_relay/). It implements the `wsproxy` form expected by libcurl.js. It forwards one ordered stream between a WebSocket and a TCP socket.

## Wire contract

```text
GET /healthz
  -> {"status":"ok","service":"0media-relay","release":"development"}

WebSocket /ws/example.com:443
  -> binary messages carrying the TCP stream in both directions
```

An encoded colon, `/ws/example.com%3A443`, is accepted through ASGI's path decoding. Double encoding is rejected because a remaining `%` cannot form a valid authority. The authority contains exactly a lowercase hostname and literal `:443`. It cannot include a path, URL scheme, user information, whitespace, query string, fragment, alternate port, trailing dot, or IP literal.

WebSocket messages do not correspond one-to-one with TLS records. A TLS record may cross several messages, or one message may contain more than one record. Neither pump parses record contents. It preserves byte order and payload bytes within each direction.

Only binary messages are forwarded. Empty binary messages are ignored and do not extend the idle timer. The Python implementation does not require a selected WebSocket subprotocol. The edge variant explicitly negotiates the `binary` subprotocol used by the socket shim.

## Admission before connection

`app.py` checks for exactly one ASCII Origin header and exactly one ASCII Host header. Origin is matched against the complete configured origin string. Host must match an allowed relay hostname; a single numeric port from 1 to 65535 may follow it. The Host header names this relay, not the upstream target.

`targets.py` checks canonical DNS label syntax and applies the destination policy. An exact entry such as `example.com` does not implicitly authorize `api.example.com`. An optional suffix such as `.media.example.org` matches its subdomains at a dot boundary; it does not match the suffix's bare root. Prefer exact hostnames where possible.

`ConnectionLimiter` uses a short lock around a counter. A full relay rejects a new upgrade immediately instead of queuing it. Its slot covers connection establishment and the complete tunnel lifetime and is released when the handler exits. The limit is per application instance/process. Adding workers or replicas multiplies capacity; there is no distributed counter.

Rejections before `websocket.accept()` become HTTP upgrade denials under ASGI. Tests can observe the application-selected close code, but a real browser may expose only a generic failed upgrade rather than a WebSocket close reason. After acceptance, upstream connection failure closes with a retryable code.

## DNS filtering and pinning

`open_public_tcp()` resolves the approved hostname once with the event loop's resolver. It deduplicates results, excludes addresses classified as non-public by `is_public_address`, and attempts the remaining addresses sequentially inside one shared connection deadline. If all answers are private or otherwise blocked, connection establishment fails. If answers are mixed, the public candidates remain usable.

Each attempt connects a nonblocking socket to the chosen numeric address. `asyncio.open_connection(sock=sock)` adopts that connected socket; it does not resolve the hostname a second time. This avoids validating one DNS answer and then connecting through a fresh lookup that could return a different address. A cancelled or failed connect closes its owned socket.

This protects the relay's direct connection decision. It does not prove the approved public service is trustworthy, prevent that service from proxying elsewhere, authorize every hostname hosted at a shared IP, or replace network egress restrictions. The relay does not parse TLS SNI or encrypted HTTP Host to bind those values to the upgrade authority. Destination policy should account for shared hosting and any approved target that acts as a proxy itself.

## Pumps, backpressure, and ownership

`tunnel.py` starts three tasks: WebSocket-to-TCP, TCP-to-WebSocket, and a watchdog. The first two transfer bytes; the third watches a monotonic last-activity clock and absolute lifetime.

The incoming pump receives one message, checks its size and projected total, writes it, and awaits `writer.drain()` before receiving another. The outgoing pump reads a bounded TCP chunk and awaits `websocket.send_bytes()`. Uvicorn's bounded incoming queue adds another limit at the WebSocket server boundary. Transport and operating-system buffers still exist; these mechanisms do not guarantee a fixed total resident-memory size.

When a pump or watchdog finishes, pending tasks are cancelled and joined, then the socket is closed and an appropriate WebSocket close is sent. If several decisions arrive together, the implementation favors the numerically higher code so a protocol/error close is not silently replaced by normal EOF. A client disconnect requires no second close message to that peer. Server cancellation attempts to close both sides and re-raises cancellation.

## Default budgets

| Setting | Default | Scope |
| --- | --- | --- |
| Connect timeout | 8 seconds | DNS and all candidate connection attempts together |
| Idle timeout | 60 seconds | A tunnel without successfully forwarded nonempty payload |
| Maximum lifetime | 600 seconds | One tunnel, regardless of activity |
| Close timeout | 2 seconds | Waiting for the TCP writer to close |
| Maximum binary message | 65,536 bytes | Incoming application message and Uvicorn message limit |
| TCP read size | 65,536 bytes | One outgoing application message |
| Transfer budget | 33,554,432 bytes | Each direction, separately, per tunnel |
| Concurrent tunnels | 128 | One relay process |
| Uvicorn incoming queue | 4 messages | Per WebSocket |

These are connection budgets. If libcurl reuses a TCP/TLS connection for several HTTP requests, the byte counter continues across those requests. New tunnels receive new budgets. Therefore the byte cap is not a daily-user quota, and the 512 MiB video representation cap does not imply a single relay tunnel can transfer that much.

| Close code | Meaning in this implementation |
| --- | --- |
| 1000 | Upstream EOF, idle deadline, or absolute lifetime reached |
| 1002 | Unexpected WebSocket event |
| 1003 | Non-binary message |
| 1008 | Policy denial, generally before upgrade |
| 1009 | Message or per-direction transfer cap exceeded |
| 1011 | Unexpected connection or transfer failure |
| 1012 | Server shutdown cancellation |
| 1013 | Capacity exhausted or upstream unavailable |

## Logging

The application logs an approved target hostname, close code, and directional byte counts after a completed tunnel. It avoids exception messages containing request-controlled data. Uvicorn HTTP access logging is disabled by the supplied entry point, but its WebSocket/server logs and any reverse proxy can still record peer IPs and upgrade paths. Logging behavior of infrastructure remains the operator's responsibility.

There is no HTTP payload logging, capture buffer, cookie database, or upstream decryption code in this backend. Health reports process readiness and a supplied release string; it does not test whether a destination is reachable.

## Optional edge backend

[`relay-edge/worker.ts`](../relay-edge/worker.ts) implements the same byte-forwarding idea with Cloudflare's `connect()` socket API. It supplies `secureTransport: "off"` because the bytes already contain the browser's TLS stream. Setting that to `on` would create a different, nested upstream TLS connection. See [the provider's TCP socket contract](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).

The edge destination list is imported from the browser policy. Set its exact relay hostname and browser origin in `relay-edge/policy.ts` for your deployment. Its admission count is per isolate, and its DNS resolution and network filtering are provided by the runtime: the Python resolver and IP-pinning implementation are not used there.

The edge implementation serializes incoming writes through a promise chain. It has message and total-byte caps, but no independent pending-write-byte high-water mark, and WebSocket `send()` does not provide the same awaitable backpressure as the Python path. Under load it can buffer substantially more data before a transfer cap or runtime limit ends a connection. The source is included for adaptation; edge validation currently covers target policy and TypeScript compilation, not a deployed Workers integration or load test.
