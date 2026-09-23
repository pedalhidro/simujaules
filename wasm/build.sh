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
# Rebuild (and commit both .wasm files) whenever backend/src/main.rs changes,
# then run `node wasm/test-wasm.mjs`.
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

chmod 644 ../engine32.wasm ../engine64.wasm   # cargo marks cdylibs executable
ls -la ../engine32.wasm ../engine64.wasm
