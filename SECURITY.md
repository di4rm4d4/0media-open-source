# Security status

This is an early source release for developers. A comprehensive security review is still pending. Tests verify specific behavior; they do not establish that the application, WebAssembly dependency, relay, or deployment is ready for unrestricted public operation.

The supplied local defaults allow only `example.com` and bind the Python service to loopback. The [architecture guide](docs/architecture.md) describes what is encrypted, who holds plaintext, and which metadata is visible. The [deployment guide](docs/deployment.md) distinguishes local development from a shared service.

Current limits include:

- No relay user authentication, per-user/per-IP quotas, or distributed abuse controls. Browser Origin matching is not authentication.
- Trusted client JavaScript, service workers, WASM, TLS trust material, and build dependencies. Client compromise exposes plaintext regardless of relay opacity.
- No TLS-content enforcement at the relay and no inspection of encrypted HTTP paths, methods, or credentials.
- Memory-only cookie handling with explicit export; no persistent encrypted account vault or guaranteed memory erasure.
- Bounded individual media work but no aggregate successful-image-cache limit. General callers must bound uploads and response consumption.
- A pinned libcurl.js compatibility target requiring dependency and cryptographic review; direct Python pins do not lock all transitive packages.
- Provider-specific edge behavior that has policy tests but has not been validated here as a deployed Workers service or under load.

Report vulnerabilities privately using [GitHub's security reporting form](https://github.com/di4rm4d4/0media-open-source/security/advisories/new). Include the affected revision, a minimal reproduction without real credentials, expected and observed behavior, and the relevant trust boundary. Do not include account cookies, access tokens, private media, or production logs in a public issue.

There is no guaranteed response-time or long-term support commitment for this initial release. For ordinary reproducible bugs without sensitive impact, use a normal issue.
