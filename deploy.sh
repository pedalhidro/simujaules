#!/usr/bin/env bash
# Build the wasm bundle and deploy the static site to
# gs://pedal-hidrografico/telhas/simujoules.
#
# Requires: rust toolchain + wasm-pack (for the wasm build), and
# gsutil (or `gcloud storage`) authenticated against a project that
# has write access to the pedal-hidrografico bucket.
#
# Usage: ./deploy.sh [--skip-wasm]
#   --skip-wasm   skip the `wasm-pack build` step (useful when you
#                 only changed HTML/JS and the existing wasm/pkg/
#                 is still good).

set -euo pipefail

BUCKET="gs://telhas/simujoules"
PUBLIC_URL="https://telhas.pedalhidrografi.co/simujoules/"

# Cloud CDN invalidation. Required so users see the new build instead of
# whatever the edge has cached. Set URL_MAP to your Cloud CDN url-map name —
# discover it with:  gcloud compute url-maps list
# Override per-run via env var:  URL_MAP=my-url-map ./deploy.sh
URL_MAP="${URL_MAP:-telhas-pedalhidrografico}"
# Path inside the URL map to invalidate. Leave the * — the simujoules
# subtree is exactly what we just deployed.
INVALIDATE_PATH="/simujoules/*"

cd "$(dirname "$0")"

SKIP_WASM=0
for arg in "$@"; do
  case "$arg" in
    --skip-wasm) SKIP_WASM=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# 1. Build the wasm bundle (writes wasm/pkg/{energy_wasm.js, energy_wasm_bg.wasm}).
if [[ "$SKIP_WASM" -eq 0 ]]; then
  echo ">> Building wasm bundle…"
  if ! command -v wasm-pack >/dev/null 2>&1; then
    echo "wasm-pack not on PATH. Install with: cargo install wasm-pack" >&2
    exit 1
  fi
  (cd wasm && wasm-pack build --target web --release --no-typescript --out-dir pkg)
else
  echo ">> Skipping wasm build."
  if [[ ! -f wasm/pkg/energy_wasm.js ]] || [[ ! -f wasm/pkg/energy_wasm_bg.wasm ]]; then
    echo "wasm/pkg/ is empty — drop --skip-wasm and re-run." >&2
    exit 1
  fi
fi

# 2. Stage the deploy. Keeps source-only files (Rust crate, QGIS plugins,
#    test harnesses, this script) out of the public bucket.
echo ">> Staging files…"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp index.html app.js energy-worker.js energy-worker-wasm.js "$STAGE/"
mkdir -p "$STAGE/dem"
cp -r dem/ "$STAGE/dem"
mkdir -p "$STAGE/wasm/pkg"
cp wasm/pkg/energy_wasm.js          "$STAGE/wasm/pkg/"
cp wasm/pkg/energy_wasm_bg.wasm     "$STAGE/wasm/pkg/"
# wasm-pack also writes a package.json + README we don't need to ship.

if ! command -v gsutil >/dev/null 2>&1; then
  echo "gsutil not on PATH. Install via the Google Cloud SDK." >&2
  exit 1
fi

# 3. Upload. Flags:
#    -m  parallelise.
#    -r  recurse into wasm/pkg/.
#    -d  delete files in the bucket that aren't in the staging dir, so
#        renames don't leave orphans.
#    -c  CRC32C-based change detection. Without it, rsync compares size
#        + mtime, but the staging dir has fresh mtimes on every run so
#        every file looks "newer" and gets re-uploaded. With -c, only
#        files whose contents actually changed are uploaded.
#    Capture stdout so we can tell whether anything moved (used below to
#    decide whether to invalidate CDN — invalidation isn't free).
echo ">> Uploading to $BUCKET …"
RSYNC_LOG="$(mktemp)"
trap 'rm -f "$RSYNC_LOG"' EXIT
gsutil -m rsync -r -d -c "$STAGE" "$BUCKET/" 2>&1 | tee "$RSYNC_LOG"
# rsync prints "Copying ..." for each upload and "Removing ..." for each
# delete. If neither appears, nothing actually changed and we can skip
# the metadata + invalidation churn.
CHANGED=0
if grep -qE '^(Copying|Removing) ' "$RSYNC_LOG"; then
  CHANGED=1
fi

# 4. Set headers. .wasm needs the right Content-Type or browsers refuse
#    to compile it; HTML gets a short cache so deploys propagate quickly,
#    everything else gets an hour. Skip when nothing changed — the headers
#    persist from the previous deploy.
if [[ "$CHANGED" -eq 1 ]]; then
  echo ">> Setting headers…"
  gsutil -m setmeta \
    -h "Content-Type: application/wasm" \
    -h "Cache-Control: public, max-age=3600" \
    "$BUCKET/wasm/pkg/energy_wasm_bg.wasm"

  gsutil -m setmeta \
    -h "Cache-Control: public, max-age=3600" \
    "$BUCKET/app.js" \
    "$BUCKET/energy-worker.js" \
    "$BUCKET/energy-worker-wasm.js" \
    "$BUCKET/wasm/pkg/energy_wasm.js"

  gsutil setmeta \
    -h "Cache-Control: public, max-age=300" \
    "$BUCKET/index.html"
fi

# 5. Invalidate Cloud CDN. Without this the edge keeps serving the old
#    build for as long as its TTL allows. The invalidation runs --async
#    (returns immediately, propagates over a few minutes); drop --async
#    if you'd rather block until it finishes. Skipped when nothing
#    changed — invalidation requests count toward GCP quota.
if [[ "$CHANGED" -eq 0 ]]; then
  echo
  echo ">> No files changed — skipping header set and CDN invalidation."
  echo "   Live at $PUBLIC_URL"
  exit 0
fi

if command -v gcloud >/dev/null 2>&1; then
  echo ">> Invalidating Cloud CDN ($URL_MAP, $INVALIDATE_PATH)…"
  if ! gcloud compute url-maps invalidate-cdn-cache "$URL_MAP" \
        --path "$INVALIDATE_PATH" --async 2>/tmp/cdn-err; then
    echo
    echo "WARNING: CDN invalidation failed. Output:"
    cat /tmp/cdn-err
    echo
    echo "Override the URL map name with:  URL_MAP=<name> ./deploy.sh"
    echo "List candidates:                 gcloud compute url-maps list"
  fi
else
  echo ">> gcloud not on PATH — skipping CDN invalidation."
  echo "   Run manually:  gcloud compute url-maps invalidate-cdn-cache $URL_MAP --path '$INVALIDATE_PATH'"
fi

echo
echo ">> Done."
echo "   Live at $PUBLIC_URL"
echo "   (CDN invalidation is async; edge propagation typically <5 min.)"
