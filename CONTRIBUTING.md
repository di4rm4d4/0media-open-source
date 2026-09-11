# Contributing

Useful contributions improve the reusable transport, relay, tests, documentation, or minimal example. Keep service-specific adapters separate from the core and keep the default example plain HTML and JavaScript.

Start with the [development guide](docs/development.md). Run the relevant checks, add a regression for changed protocol behavior, and explain the problem and resulting behavior in your pull request. Document changes to destination policy, resource ownership, limits, cookies, redirects, or the worker protocol.

Use synthetic or public test data. Do not contribute account sessions, browser profiles, request captures containing credentials, private service addresses, copied platform artwork, or original product deployment configuration. Report security issues through the private channel in [SECURITY.md](SECURITY.md).

For platform-specific work, describe the adapter contract and documented API requirements rather than adding a prebuilt social application to this example. Preserve the existing license notices and identify new dependencies and their licenses.
