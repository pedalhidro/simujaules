#!/usr/bin/env bash
# Builds the in-browser engines from backend/src/main.rs (include!d verbatim by
# src/lib.rs) and copies them next to the app, where deploy.sh ships them:
#
#   ../engine32.wasm  wasm32 — stable toolchain; every browser, ≤ 4 GiB memory
#   ../engine64.wasm  wasm64 (Memory64) — nightly + build-std (the target is
#                     tier 3); Chrome ≥ 133 / Firefox ≥ 143, up to 16 GiB.
#                     --max-memory DECLARES that maximum: without it Firefox
#                     re-allocates (copies) a memory64 memory on every grow —
#                     measured quadratic, 256 MiB of 1 MiB grows = 24 s — while
#                     a declared maximum lets it reserve and grow in place.
#
# Rebuild (and commit both .wasm files PLUS wasm/engine-sources.sha256)
# whenever backend/src/main.rs changes, then run `node wasm/test-wasm.mjs`.
# engine-sources.sha256 records the hashes of the build inputs; test-wasm.mjs
# fails when they no longer match, i.e. when the committed modules are stale.
#
# One-time toolchain setup:
#   rustup target add wasm32-unknown-unknown
#   rustup toolchain install nightly --profile minimal --component rust-src
set -euo pipefail
cd "$(dirname "$0")"

echo ">> wasm32 (stable)"
cargo build --release --target wasm32-unknown-unknown --target-dir target/w32
cp target/w32/wasm32-unknown-unknown/release/simujaules_wasm.wasm ../engine32.wasm

echo ">> wasm64 (nightly, build-std, 16 GiB max memory)"
RUSTFLAGS="-C link-arg=--max-memory=17179869184" \
  cargo +nightly build -Zbuild-std=std,panic_abort --release \
  --target wasm64-unknown-unknown --target-dir target/w64
cp target/w64/wasm64-unknown-unknown/release/simujaules_wasm.wasm ../engine64.wasm

# Record the build inputs (repo-relative, fixed order) for the staleness guard.
cd ..
if command -v sha256sum >/dev/null 2>&1; then SHA=(sha256sum); else SHA=(shasum -a 256); fi
"${SHA[@]}" backend/src/main.rs wasm/src/lib.rs wasm/Cargo.toml wasm/Cargo.lock > wasm/engine-sources.sha256
cd wasm

chmod 644 ../engine32.wasm ../engine64.wasm   # cargo marks cdylibs executable
ls -la ../engine32.wasm ../engine64.wasm
