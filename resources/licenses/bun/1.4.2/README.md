# Bundled Bun 1.4.2

Bun includes statically linked JavaScriptCore/WebKit and other components.
Read BUN-LICENSE.txt and the LGPL texts; Dokkabi's MIT license does not replace
their terms. Upstream license text and downloaded text digests are recorded in
provenance.json. These notices alone do not establish complete binary
redistribution qualification.

Source: https://github.com/oven-sh/bun/tree/744846f844374847c902b5e7fd59b4342a51ef99
Patched JavaScriptCore: https://github.com/oven-sh/WebKit/tree/2e2aa2290fac856d6f451ceacb58f7f5b44dd057

To rebuild with a modified library, check out Bun's pinned revision, follow its
BUILD.md/toolchain prerequisites, run `bun sync-webkit-source` to select the
revision in scripts/build/deps/webkit.ts, then `bun run build:local`. Preserve
all linked-library notices and source pins from that source tree. Replace
Contents/Resources/dokkabi-runtime/bin/bun with the resulting compatible
executable, then update its path/size/SHA-256 entry in manifest.json; do not
disable runtime integrity verification. Dokkabi's unsigned distribution does
not impose a signing key requirement on a locally modified app.

Before publishing a binary, retain and make available the exact corresponding
source, patches and build instructions for the shipped runtime and its LGPL
components, and audit the remaining linked-library notices. A generic link to
the latest upstream source is not a substitute. Qualification must record the
source archive hashes and a tested replacement/rebuild path alongside the
binary receipt. Until that evidence exists, source snapshots may be prepared
but binary release clearance remains open.
