# Development and verification

This repository is self-contained. It does not depend on a checkout of the original 0media application, private deployment scripts, production relay addresses, or platform accounts.

## Checks

From the repository root:

```sh
npm ci
npm run check
python3.12 -m venv .venv
.venv/bin/python -m pip install -r relay/requirements-test.txt
.venv/bin/python -m pytest -q relay/tests
```

The frontend command runs Vitest, TypeScript checking, and the production build. Python tests use the configuration in `relay/pyproject.toml`. CI uses hosted Linux runners, runs these checks, and builds the relay container. It has no deployment job, repository write permission, or runtime service secrets.

## What the tests exercise

| Area | Examples of covered behavior |
| --- | --- |
| Browser TLS ownership | Lazy initialization, explicit headers, aborts around awaited preparation, closed sessions, safe polling cleanup, cookie/session resource ownership. |
| Browser policy | Local-only plain WebSocket, approved HTTPS destinations, forbidden ports/credentials/fragments, relay URL normalization. |
| Response consumption | Actual-byte bounds, cancellation, and reader cleanup. |
| Images | Coalescing, caller cancellation, deadlines, bounded bodies, cache lifetime, object URL cleanup. |
| Video | Download/lease admission, supported types, byte limits, explicit rendition retry, aborting late/stalled responses. |
| Progressive bridge | Range math and validation, ownership, invalidation, worker capability/interception, protocol errors, and lifecycle cleanup. |
| Python relay | Origin/Host validation, binary forwarding, limits, capacity, DNS address filtering, pinned socket connections, cancellation, resource closure, and log redaction. |
| Edge relay | Destination policy, origin and binary protocol checks, and TypeScript checking of the implementation. |

Frontend tests mock the WASM session and browser APIs where necessary. They do not prove the compiled cryptographic library is correct or substitute for a real browser. Relay tests use controlled connectors and fake sockets to make policy and cancellation reproducible without sending account traffic.

## Manual end-to-end check

Start the relay and HTML example using the README instructions. Press Send on `https://example.com/` and verify an HTTP response appears as literal text. Close the session and verify the displayed response is cleared. An unapproved destination should fail before a relay connection is created. Repeatedly submitting and cancelling should leave the form usable.

Test the built version too: stop the development server, run `npm run build`, then `npm run preview` on port 4173. That exercises the generated WASM chunk rather than only Vite's development module loading.

For a media integration, use public sample media that you control, add its exact host to both policies, and exercise seek, pause, resume, navigation, worker replacement, aborted ranges, and lease release in a real browser. The default form has no media player, and `example.com` is not a media fixture host. Workers runtime deployment and broad browser/device coverage are separate validation tasks.

## Dependency maintenance

The browser dependency is pinned to libcurl.js 0.7.1, the version whose lifecycle boundaries this extraction retains. That pin is a compatibility choice, not a claim that it is the latest or free of known vulnerabilities. Before a dependency upgrade, inspect the session implementation, WASM/TLS build and trust bundle, redirects, cookie semantics, cancellation behavior, and licensing materials.

The wrapper currently guards `stream_response` and clears `event_loop`. Keep those regression tests while determining whether a newer dependency provides the guarantees itself. If the API no longer supports a safe guard, fail explicitly instead of issuing an unguarded request.

The JavaScript lockfile fixes package versions and integrity values. Python runtime requirements pin direct packages, with transitive resolution left to pip. A release intended for wider use should inventory that resolved environment, review dependency advisories and base-image updates, and preserve build inputs. None of the passing tests represents a full dependency or cryptographic audit.

## Source map

Read `example.js` for ownership at the application boundary, `transport/browser-tls.ts` for the WASM integration, `relay/zero_media_relay/app.py` for admission, `upstream.py` for connection establishment, and `tunnel.py` for forwarding. Then read `transport/media/video-bridge.ts` alongside `public/video-sw.js` to follow both halves of the optional playback protocol.

Keep generated output, dependency directories, virtual environments, account captures, cookie jars, and local configuration outside the tracked tree. Contributions should include a focused regression for changed protocol behavior and update the corresponding explanation when a boundary or default changes.
