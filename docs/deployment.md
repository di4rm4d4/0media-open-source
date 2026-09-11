# Deployment and configuration

The quickstart binds the Python relay and the Vite example to loopback. It is the supported starting point for developing a fork. Public exposure requires decisions about who can open tunnels, destination policy, traffic budgets, and trusted client-code delivery.

## Python configuration

Run `python -m zero_media_relay.server` with `relay/` on `PYTHONPATH`, or use the included container. The supplied server entry point applies WebSocket size/queue settings, disables compression and HTTP access logs, and disables trust of forwarded proxy headers.

| Variable | Default | Accepted setting |
| --- | --- | --- |
| `RELAY_BIND_HOST` | `127.0.0.1` | Listening address; container sets `0.0.0.0` internally |
| `PORT` | `8080` | 1–65535 |
| `RELAY_ALLOWED_ORIGINS` | `http://127.0.0.1:4173,http://localhost:4173` | Comma-separated exact HTTPS origins, or HTTP loopback origins with explicit ports |
| `RELAY_ALLOWED_HTTP_HOSTS` | `127.0.0.1,localhost` | Comma-separated relay hostnames, without ports |
| `RELAY_CONNECT_TIMEOUT_SECONDS` | `8` | 0.1–60 |
| `RELAY_IDLE_TIMEOUT_SECONDS` | `60` | 1–600 |
| `RELAY_MAX_CONNECTION_SECONDS` | `600` | 10–3600 |
| `RELAY_CLOSE_TIMEOUT_SECONDS` | `2` | 0.1–10 |
| `RELAY_MAX_FRAME_BYTES` | `65536` | 1024–1048576 |
| `RELAY_MAX_BYTES_EACH_DIRECTION` | `33554432` | At least one permitted frame, at most 1 GiB |
| `RELAY_READ_BUFFER_BYTES` | `65536` | At least 1024, at most the frame limit |
| `RELAY_MAX_CONNECTIONS` | `128` | 1–4096 per process |
| `RELEASE_SHA` | `development` | Short release identifier; use the build's commit hash |
| `LOG_LEVEL` | `info` | Uvicorn/logging level |

Empty origin/host sets, wildcard origins, `null` origins, and malformed values fail configuration. An origin is just scheme, host, and optional port; do not add a path or trailing slash. Destination hosts remain code policy, not an environment setting.

## Container

`compose.yaml` builds the Python relay from a digest-pinned Python 3.12 base image. The image runs as UID/GID 10001. Compose drops Linux capabilities, enables no-new-privileges, uses a read-only root filesystem with a small temporary filesystem, and sets process and memory limits. Host publication remains `127.0.0.1:8080`.

The runtime package versions in `relay/requirements.txt` are pinned at the top level. Their transitive dependencies are not fully locked. The pinned base-image digest does not make all future Python installs bit-for-bit reproducible. Record a complete resolved dependency inventory and update the base image as part of a release process.

## Remote topology

Use an HTTPS origin to serve the built client and WSS for the relay. A reverse proxy can terminate outer TLS and forward the WebSocket upgrade to the local Python process. Its upstream should remain private. Preserve the browser Origin and the intended relay Host; do not rewrite arbitrary requests to an allowed Origin.

For a deployment you control, values would have this shape:

```text
Client origin:              https://client.example.org
Client transport relayUrl:  wss://relay.example.org/ws/
RELAY_ALLOWED_ORIGINS:      https://client.example.org
RELAY_ALLOWED_HTTP_HOSTS:   relay.example.org
Python listener:            127.0.0.1:8080
```

These domains are placeholders. Configure your ingress for HTTP/1.1 WebSocket upgrade forwarding, compatible message limits and timeouts, and no response caching or body logging on `/ws/`. Route `/healthz` separately if you want to restrict health visibility. If the proxy passes an internal Host instead, configure that exact host consciously and retain an external host restriction at ingress.

The relay's Origin check cannot authenticate a non-browser client. The current protocol includes no relay access token, account identity, per-user quota, or per-IP admission limiter. Shared public operation needs those controls at an appropriate edge or a deliberately extended upgrade protocol. Browser WebSocket clients cannot simply attach arbitrary Authorization headers. Do not add a long-lived secret to a JavaScript bundle or query string as a substitute for an authentication design.

Use network egress restrictions as a separate layer and consider how allowed services could themselves expose proxy functionality. The relay can constrain sockets; it cannot read encrypted HTTP paths to apply an API-level policy. Adding replicas also multiplies the process-local connection limit.

## Serving the client

`npm run build` creates `dist/`; `npm run preview` lets you test that production build locally. The output includes the plain HTML client, its JavaScript/WASM dependency bundle, worker scripts, and license notices. Vite is build tooling; no UI framework is required at runtime. The source `.ts` imports in the development example are resolved during this build.

The client code host can change software that handles plaintext. Use an immutable reviewed build, trusted dependency installation, HTTPS, and a release/update process that makes changes reviewable. Do not add analytics scripts to a page that owns account sessions without considering their access. Choose a Content Security Policy for your final origin, WSS endpoint, WebAssembly loading, and optional blob media, and test it against the actual build.

For progressive video, serve `sw.js` and `video-sw.js` at the origin root with update behavior consistent with `updateViaCache: "none"`. Do not rewrite `/_0media/video/*` failures into external fetches. The example does not register the worker until an integration explicitly opts into media support.

Before redistributing a compiled browser build, preserve its third-party notices and arrange access to the matching library source and rebuild materials described in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Optional Workers deployment

The edge source is in `relay-edge/worker.ts`; `runtime.d.ts` describes the small provider API surface used by TypeScript. It is independent of the Python container. Point a Workers project at that entry point, set the exact hostname/origin constants in `relay-edge/policy.ts`, and attach your own domain and deployment configuration. No account ID, production route, deployment token, or automatic publish job is included.

Validate that environment with the actual libcurl.js browser client and with slow-peer/load tests before depending on it. Its provider-managed DNS, isolate-local limits, and queue behavior differ from the Python implementation, as explained in [the relay guide](relay.md#optional-edge-backend). Cloudflare may also reject some destinations through its own socket policy; an approved project hostname is not a promise of provider reachability.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| Page works as a file but Send fails | Use the Vite HTTP URL; `file:`/`null` is not an allowed origin and cannot serve the source modules. |
| WebSocket upgrade rejected | Exact Origin, relay Host, destination list, `:443`, query-free `/ws/` route, capacity. |
| Accepted connection closes immediately | Public DNS answers, outbound TCP access, upstream availability, connection deadline. |
| Generic TLS failure | Destination certificate and trust material, local clock, upstream TLS compatibility; do not disable verification to hide it. |
| Large media stops partway | Per-tunnel byte budget, deadline, rendition size, range support, or stale response validators. |
| Relay address cannot change | libcurl.js uses a global setting; reload the page before choosing another relay. |
| Progressive video falls back to a blob | Worker control, exact root paths, secure context, real interception probe, range support. |

The automated tests isolate many of these cases without contacting real platforms. A working health endpoint alone verifies none of the browser TLS or upstream request path.
