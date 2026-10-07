# Build and install

## Source layout

The repository root is the Bun harness workspace. `app/` is the separate pnpm
workspace for the Electron/React desktop shell. Install each with its committed
lockfile. Do not replace either lockfile with a developer's local resolution.
`PUBLIC-SNAPSHOT.json` inventories original exported file sizes and SHA-256
digests; it excludes itself and later install/build outputs.

## Harness: macOS and Linux

Use Bun 1.4.2 for the release candidate. From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run test
bun run dokkabi --help
```

The exported tests are a synthetic subset covering snapshot boundaries, event
log integrity, graph/plugin lifecycle replay, work sealing and manifest closure. They are not a benchmark or
a copy of private experiment logs. Linux qualification requires an existing
Linux host; a macOS result does not establish Linux acceptance.

## Desktop: macOS

Prerequisites: Node 24.13.1 or newer compatible Node 24, pnpm 11.10.0, Bun 1.4.2,
Xcode command-line tools and the Rust toolchain pinned in `app/rust-toolchain.toml`.
Apple Silicon is the currently qualified target. Inherited mobile, Windows,
Linux GUI, cloud deployment and upstream publication scripts are unsupported
product paths. No GitHub Actions are shipped with this snapshot.

```sh
cd app
pnpm install --frozen-lockfile
pnpm licenses:sync
pnpm build:desktop
DOKKABI_DESKTOP_HARNESS_SOURCE="$(cd .. && pwd)" \
DOKKABI_DESKTOP_BUN="$(command -v bun)" \
pnpm dist:desktop:artifact --platform mac --target zip --arch arm64
```

If an installed Xcode toolchain cannot find standard C++ headers, confirm the
SDK is installed and explicitly select its existing headers for the build:

```sh
export SDKROOT="$(xcrun --show-sdk-path)"
export CPLUS_INCLUDE_PATH="$SDKROOT/usr/include/c++/v1"
```

This selects existing tools; it does not reinstall or replace the host OS.
Native packaging remaps the source/staging roots independently of build HOME.

Commit the public snapshot before bundling: runtime staging requires a clean
Git checkout and archives the exact harness revision. The app keeps execution,
model policy and acceptance in the bundled harness. Setting up an inherited
provider adapter alone does not activate Dokkabi execution. Packaging runs with
publication disabled and automatic updates remain off. Source build success is
separate from installed-app, privacy and license redistribution qualification.

## Manual unsigned installation

There is no official binary release for the current source preview. When a
qualified release becomes available, download its macOS ZIP/DMG and SHA256SUMS, verify
the checksum, and move the app to Applications. Open it once. If macOS blocks
it, use System Settings → Privacy & Security → Open Anyway, then confirm Open.
Do not disable Gatekeeper globally or remove quarantine from unrelated files.
Use the existing application identity/profile; back it up before replacement.
Do not infer notarization or Intel compatibility from the arm64 artifact.

## Bundled runtime and licenses

Runtime resources include the harness MIT license, version-specific Bun notices
and a manifest of file hashes. An unknown Bun version, missing notice or altered
license digest fails staging. See `app/licenses/bun/1.4.2/README.md` for exact
source pins and the replacement/rebuild procedure. Binary release requires
corresponding-source and linked-library qualification in addition to notices.
