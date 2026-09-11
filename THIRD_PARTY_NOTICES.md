# Third-party notices

The project's own code is covered by the root [MIT license](LICENSE). Dependencies retain their own licenses. This source repository does not vendor the WASM binary or its complete upstream C/C++/Rust build sources; installation obtains the pinned npm package, and a frontend build includes it in generated output.

## libcurl.js 0.7.1

The browser transport imports `libcurl.js/bundled` from the unmodified npm package **libcurl.js 0.7.1**, authored by ading2210 and licensed **LGPL-3.0-or-later**.

- [Upstream project](https://github.com/ading2210/libcurl.js)
- [Pinned npm package archive](https://registry.npmjs.org/libcurl.js/-/libcurl.js-0.7.1.tgz)
- [Upstream revision with the 0.7.1 version manifest](https://github.com/ading2210/libcurl.js/tree/9317579cef21637847e037418868edd53aad928e)
- [Exact package license](https://unpkg.com/libcurl.js@0.7.1/LICENSE)
- Local [LGPL 3.0](LICENSES/LGPL-3.0.txt) and accompanying [GPL 3.0](LICENSES/GPL-3.0.txt) texts

The lockfile records the package integrity:

```text
sha512-0wZSgCj0wqc3n/W8Lrsagm5E5FXEj41hvQF6bp5o4m3kutxAV2XRHuhudvVOwKxMJqRb4VlHxuUhQvkFAVUwQw==
```

The upstream revision link identifies a source revision declaring this version. It is not a claim that this repository has reproduced the npm WASM binary bit for bit. The npm archive contains compiled outputs and is not by itself the complete corresponding source for the compiled library and its embedded dependencies.

The project-side compatibility code is in `transport/browser-tls.ts`, with local type declarations in `transport/libcurl-js.d.ts`. It applies guards to owned runtime session objects; it does not patch the installed npm package files.

## Replacing and rebuilding the library

Install the project with `npm ci`. To use a modified, interface-compatible library, build/package it from the upstream sources using its documented toolchain, install that package in place of `libcurl.js`, and run `npm run check`. For example, `npm install /absolute/path/to/libcurl.js-package.tgz` selects a locally built package and updates the lockfile. Keep the bundled entry point and recheck the two lifecycle guards against your library version.

The application source and build configuration needed to rebuild the combined browser output are included here. There is no project-imposed restriction on reverse engineering for debugging modifications to the library. `npm run build` copies this notice and the license texts into `dist/`.

When distributing a compiled browser build, preserve these notices and the applicable licenses and provide matching corresponding library source, embedded-dependency notices, and any required rebuilding materials through a suitable distribution arrangement. Follow the upstream submodules and build scripts for the selected revision; a bare link to a moving default branch or to the npm binary package is not a verified source bundle. This repository's source release and a separately hosted compiled distribution are different artifacts.

## Other dependencies

The Python runtime directly depends on Starlette, Uvicorn, and websockets. Their code is installed by pip and remains under their respective upstream licenses. JavaScript build/test dependencies and Python transitive dependencies are recorded in the lockfile or installed environment; generated binary/container distributions should include the notices for what they actually contain. No platform artwork or social-service SDK is bundled with this example.
