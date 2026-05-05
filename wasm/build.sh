#!/usr/bin/env bash
# Build the wasm bundle for the energy worker.
# Output goes to ./pkg, which energy-worker-wasm.js imports.
set -euo pipefail
cd "$(dirname "$0")"
exec wasm-pack build --target web --release --no-typescript --out-dir pkg
