# Changelog

## Unreleased

### Added

- `requestBytes`, `requestText`, and `requestJson` helpers with response limits, deadlines covering startup through body consumption, caller cancellation, and HTTP error metadata. JSON results remain `unknown` until validated by the adapter.
- `ImageLoader.release(source)` for explicit cache eviction and object URL cleanup.
- Public exports for `readVideoRange`, `VideoMetadata`, `RangeUnsupportedError`, `retryAfterMs`, and `TransportTargetError`.
- A typechecked pagination example with response validation, finite page count, repeated-cursor detection, and demand-driven requests.
- A plain text/JSON request form included in both the development server and production build.

### Fixed

- Cancelling a request can stop its wait for shared WASM initialization or body preparation immediately.
- Late response headers after cancellation or session closure cannot read a cleared libcurl handle.
- Bounded response cleanup does not wait indefinitely for a stream source's asynchronous cancellation hook.
- Queued images receive their full network deadline after admission.
- A truncated video range with a nonempty prefix and a valid strong ETag can recover its missing tail once, within the original deadline and byte bound.

### Compatibility

The source entry point and plain HTML example remain in place. The browser dependency stays pinned to libcurl.js 0.7.1. The release uses the public package; it does not require the main application's custom WASM build, platform clients, account-verification services, or production infrastructure.

## Initial source release · 11 September 2026

Browser TLS transport, Python and edge relays, image/video loaders, progressive playback bridge, a plain HTML request inspector, and component documentation.
