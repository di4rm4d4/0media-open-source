# Build the client you want

The included HTML demonstrates one request and the lifetime of one transport. It intentionally leaves the application layer small enough to replace. An Instagram client, an X client, a Facebook client, or a client for your own service would share the lower layers and implement different adapters above them.

## Separate transport, adapter, and view

Keep network transport in `BrowserTlsTransport`. Put a service's URLs, request formats, login state, pagination, and response parsing in a separate adapter. Let a view render normalized data with ordinary DOM APIs or a framework of your choice.

For example, an adapter for **an API you control** could look like this. The hostname and endpoint are illustrative; they are not endpoints for any named social platform:

```js
import { requestJson } from "./transport/index.ts";

export function createExampleAdapter(fetch) {
  return {
    async listItems(signal) {
      const payload = await requestJson(fetch, "https://api.example.org/items", {
        headers: { accept: "application/json" },
        credentials: "omit", signal,
        timeoutMs: 15_000, maxBytes: 512 * 1024,
      });
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
        throw new Error("Unexpected items response.");
      }
      return payload.items.slice(0, 100).map(item => {
        if (typeof item.id !== "string" || typeof item.text !== "string") {
          throw new Error("Unexpected item format.");
        }
        return { id: item.id, text: item.text };
      });
    },
  };
}
```

Pass `transport.fetch` into that adapter. The caller supplies a view/account cancellation signal; the helper owns the per-request deadline and HTTP cleanup. Render text with `textContent`. Do not insert a remote HTML response directly into your application's DOM; untrusted markup would run inside the page that owns plaintext and cookies.

For a complete, typechecked pagination example, see [`examples/pagination.ts`](../examples/pagination.ts). It validates each page, keeps cursors on the original endpoint, caps page count, stops repeated cursors, and requests a continuation only when the consumer asks for it. Its service contract is illustrative and tested with synthetic data. Adapt that contract to your own documented API.

## Add your service to both policies

Edit [`transport/policy.ts`](../transport/policy.ts):

```ts
export const ALLOWED_TLS_HOSTS = new Set(["example.com", "api.example.org"]);
export const ALLOWED_TLS_SUFFIXES = new Set<string>();
```

Then edit [`relay/zero_media_relay/policy.py`](../relay/zero_media_relay/policy.py):

```python
ALLOWED_TLS_HOSTS = frozenset({"example.com", "api.example.org"})
ALLOWED_TLS_SUFFIXES: frozenset[str] = frozenset()
```

These are examples: replace `api.example.org` with a real service you intend to access. Restart the relay and reload/rebuild the client after changes. The optional edge relay imports the browser list, but it also has its own relay-host and client-origin settings.

Adding an API hostname does not automatically add a login hostname, redirect destination, media CDN, or subdomain. Document each required host and why it belongs. A suffix can be useful for rotating media hosts, but it authorizes all matching subdomains, including any that other parties can control. Avoid broad shared-service suffixes.

The Python target list has no environment-variable override. Host expansion is a code change that can be reviewed alongside the adapter. Keep rejection tests for lookalike names, private addresses, alternate ports, and double-encoded authorities when extending the policy.

## Authentication belongs to the adapter

This code is a transport foundation, not a universal social login. It cannot infer a service's current API contracts, CSRF rules, OAuth flow, device challenges, permissions, or session validity.

Prefer documented APIs and supported authorization flows where available. A browser application cannot keep a bundled client secret confidential. Some flows may require an application backend distinct from the opaque relay; document what that backend sees. A remote browser or verification service has additional access to account information and must not be described as merely forwarding opaque bytes.

For cookie-based sessions, opt into a WASM cookie jar and use `credentials: "include"` on the intended requests. Importing an exported jar is an explicit sensitive-data operation. Parse only the service-specific fields you need, never log complete jars, and handle logout, expiration, and invalidation. For token-based requests, build Authorization headers only for the intended approved service.

The independent HTTP stack does not apply native Fetch CORS response filtering. This does not grant an upstream account permission or make an unsupported API stable. Ordinary server authentication, service controls, and application authorization still apply. The upstream sees the relay's egress address, which can affect reliability and rate limits.

## A small implementation sequence

1. Get one unauthenticated or explicitly authorized read request working and display its bounded response as text.
2. Extract that request into an adapter and validate the response shape before rendering.
3. Add pagination with a finite page size, cancellation on navigation, and visible error states.
4. Add service authentication if needed, with clear ownership of the transport and credentials.
5. Add images or video through the provided loaders, and release their resources when a view ends.
6. Add write operations deliberately, with controls that make the requested action clear to the user. Do not retry an uncertain write automatically.

For read retries, classify failures first. Respect a returned Retry-After, cap retry counts, and stop on cancellation or a login requirement. `ProtocolError` can carry a status and retry delay for media; the general transport returns ordinary Responses or dependency errors. A failed upgrade may not expose a detailed close reason to page JavaScript.

You can replace `index.html` completely, keep it as a debugging page, or copy the `transport/` modules into another bundler project. Retain the dependency and license notices. The package is marked `private: true` to prevent accidental npm publication; it is source to build on, not a promise of an already-published npm package or stable API.
