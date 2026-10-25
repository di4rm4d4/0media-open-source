# 0media transport

Browser-owned HTTP and TLS, an opaque WebSocket relay, and reusable media loaders for independent web clients.

This repository extracts the transport machinery from 0media into a standalone project. The example client is a hand-written HTML form and a small JavaScript file. It makes a real HTTPS request through your own relay and displays the response as text. There is no UI framework, feed, platform branding, or prebuilt Instagram, X, or Facebook client. You supply the platform integration and interface.

## How 0media uses this

0media uses this architecture to help keep web clients accessible despite dystopian app bans. Clients can route connections through relays in countries chosen for service availability and user safety, with the upstream service seeing the relay's outgoing IP address. TLS remains between the browser and the upstream service, so the relay carries encrypted traffic without decrypting requests or responses. Relay placement is an operator decision; this repository gives others the transport and backend to build their own clients and access routes.

## What is included

| Component | What it does |
| --- | --- |
| [`transport/browser-tls.ts`](transport/browser-tls.ts) | A fetch-like API using libcurl.js in WebAssembly, with browser-owned TLS, optional in-memory cookies, cancellation, and session cleanup. |
| [`transport/request.ts`](transport/request.ts) | Bounded byte, text, and JSON requests with deadlines, cancellation, HTTP errors, and Retry-After information. |
| [`relay/`](relay/) | A Python WebSocket-to-TCP relay with destination restrictions, public-IP filtering, DNS pinning, connection limits, deadlines, and bounded transfers. |
| [`relay-edge/`](relay-edge/) | An optional Cloudflare Workers relay implementation, with its runtime differences documented. |
| [`transport/media/`](transport/media/) | Image downloads, revocable video leases, strict HTTP range validation, and progressive playback through a service worker. |
| [`index.html`](index.html), [`example.js`](example.js) | The smallest useful client: enter a request, send it, inspect the response, cancel, or close the session. |
| [`examples/`](examples/README.md) | A runnable text/JSON form and a tested pagination adapter for an API you control. |
| [`docs/`](docs/) | Architecture, packet flow, API behavior, relay internals, media streaming, integration, deployment, and testing guides. |

This is an early developer release. It has automated regression tests and a working local example; it has not completed a comprehensive security audit. The relay ships with **only `example.com` allowed**, and listens on loopback by default. See [the security model](docs/architecture.md#trust-and-visibility) and [current limitations](SECURITY.md).

## Run the example

Use Python 3.12 and Node 24.15 or newer in the Node 24 line. Other supported Node versions are listed in `package.json`. The project records npm 11.17.0 as its package manager.

In one terminal, from the repository root:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r relay/requirements.txt
PYTHONPATH=relay .venv/bin/python -m zero_media_relay.server
```

In a second terminal, from the same directory:

```sh
npm ci
npm run dev
```

Open [the local example](http://127.0.0.1:4173/) and press **Send request**. Leave the initial URL as `https://example.com/`. The response should show `HTTP 200` and the Example Domain HTML as inert text. Internet access is required for that request. Run the page over HTTP on localhost; opening `index.html` directly as a file will not work.

The browser connects to `ws://127.0.0.1:8080/ws/`. Only this local outer connection uses plain WebSocket; the request to `example.com` still uses TLS established inside WebAssembly. Remote deployments require WSS.

Alternatively, `docker compose up --build` starts the Python relay with the same local ports. The HTML client still runs separately with `npm run dev`.

## Make a bounded request

Import the source through Vite or another TypeScript-aware bundler:

```js
import { BrowserTlsTransport, requestText } from "./transport/index.ts";

const transport = new BrowserTlsTransport({
  relayUrl: "ws://127.0.0.1:8080/ws/",
});

try {
  const html = await requestText(transport.fetch, "https://example.com/", {
    timeoutMs: 15_000,
    maxBytes: 256 * 1024,
  });
  document.querySelector("pre").textContent = html;
} finally {
  transport.close();
}
```

The request helpers cover startup, headers, and body consumption with one deadline and release the HTTP handle after completion. `requestJson` returns `unknown` for your adapter to validate. HTTP failures carry `status` and, when supplied, `retryAfterMs`; helpers do not retry. Use `transport.fetch` directly when you need response headers, manual redirects, or streaming. See [the API guide](docs/browser-transport.md) and [examples](examples/README.md).

## Build on it

Start by reading [the architecture](docs/architecture.md), then [building your own client](docs/building-a-client.md). Change the browser and relay destination policies together. Implement your chosen service's requests, authentication, response parsing, and UI above the transport.

The project does not ship platform login automation, account storage, a hosted relay service, production credentials, or the original product's deployment infrastructure.

Read the guides in order or jump to a component:

1. [Architecture and trust boundaries](docs/architecture.md)
2. [Browser transport API and lifecycle](docs/browser-transport.md)
3. [Relay wire protocol and implementation](docs/relay.md)
4. [Encrypted media fetching and progressive video](docs/media.md)
5. [Building an Instagram, X, Facebook, or other client](docs/building-a-client.md)
6. [Deployment and configuration](docs/deployment.md)
7. [Development, tests, and dependency maintenance](docs/development.md)

Recent changes are recorded in the [changelog](CHANGELOG.md).

## License

The 0media code in this repository is [MIT licensed](LICENSE). The browser transport depends on **libcurl.js 0.7.1, LGPL-3.0-or-later**. Its license remains separate. See [third-party notices](THIRD_PARTY_NOTICES.md) for source links, the pinned package, and rebuilding information.
