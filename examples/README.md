# Examples

The examples use the same public entry point, [`transport/index.ts`](../transport/index.ts). Run the browser examples through Vite or another TypeScript-aware bundler. The repository does not supply a hosted relay or a platform API.

## Inspect a request

Run the root [HTML form](../index.html) with the relay described in the [README](../README.md#run-the-example). It uses the raw transport so you can inspect response status, headers, redirects, and bounded body text. Responses are rendered with `textContent`.

For application code that only needs a result:

```js
import { BrowserTlsTransport, requestText } from "../transport/index.ts";

const transport = new BrowserTlsTransport({
  relayUrl: "ws://127.0.0.1:8080/ws/",
});
try {
  const text = await requestText(transport.fetch, "https://example.com/", {
    timeoutMs: 15_000, maxBytes: 256 * 1024,
  });
  console.log(text);
} finally {
  transport.close();
}
```

This import is relative to a module inside `examples/`. See [the request API](../docs/browser-transport.md#request-helpers) for JSON, cancellation, and HTTP errors.

The [bounded request form](request.html) runs at `http://127.0.0.1:4173/examples/request.html` alongside the root inspector, in both development and the production preview. It uses `requestText` or `requestJson` directly, keeps cookies disabled, and demonstrates cancellation and session closure. The initial `example.com` URL works in Text mode. JSON mode requires your own approved JSON endpoint.

## Paginate an API you control

[`pagination.ts`](pagination.ts) shows a complete adapter for this illustrative JSON contract:

```json
{
  "items": [{ "id": "one", "title": "First item" }],
  "nextCursor": "opaque-cursor"
}
```

The last page returns `"nextCursor": null`. Each page contains at most 100 items. The adapter validates those fields and returns only `id` and `title`.

After adding your actual API host to both destination policies, pass its endpoint and your transport into the adapter:

```js
import { itemPages } from "./pagination.ts";

// transport, itemsEndpoint, list, and viewController belong to your app.
for await (const items of itemPages(transport.fetch, itemsEndpoint, {
  signal: viewController.signal, maxPages: 10,
})) {
  for (const item of items) {
    const row = document.createElement("li");
    row.textContent = item.title;
    list.append(row);
  }
}
```

The endpoint remains fixed; a returned cursor is a query parameter, never a new URL. Breaking out of the loop makes no further requests. A failed continuation throws while already-rendered items stay visible. Repeated cursors and the page cap throw explicit errors. The caller decides whether to show a retry or resume action.

The adapter is typechecked by `npm run build` and exercised without network access by:

```sh
npm test -- tests/examples.test.ts
```

## Display media

The [media guide](../docs/media.md) contains image and video integration examples, including source release, playback leases, worker setup, and cleanup on navigation. Supply reviewed media URLs from your adapter. The default `example.com` policy does not include a sample media service.
