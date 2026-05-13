#!/usr/bin/env bash
# Deploy the static site to gs://pedal-hidrografico/telhas/simujoules.
#
# Requires: gsutil (or `gcloud storage`) authenticated against a project
# that has write access to the pedal-hidrografico bucket.
#
# Usage: ./deploy.sh

set -euo pipefail

BUCKET="gs://telhas/simujoules"
PUBLIC_URL="https://telhas.pedalhidrografi.co/simujoules/"

# Cloud CDN invalidation. Required so users see the new build instead of
# whatever the edge has cached. Set URL_MAP to your Cloud CDN url-map name —
# discover it with:  gcloud compute url-maps list
# Override per-run via env var:  URL_MAP=my-url-map ./deploy.sh
URL_MAP="${URL_MAP:-tiles-map}"
# Path inside the URL map to invalidate. Leave the * — the simujoules
# subtree is exactly what we just deployed.
INVALIDATE_PATH="/simujoules/*"

cd "$(dirname "$0")"

if [[ $# -gt 0 ]]; then
  echo "deploy.sh takes no arguments; got: $*" >&2
  exit 2
fi

# 1. Stage the deploy. Keeps source-only files (QGIS plugins,
#    test harnesses, this script) out of the public bucket.
echo ">> Staging files…"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp index.html app.js energy-worker.js "$STAGE/"
mkdir -p "$STAGE/dem"
cp -r dem/ "$STAGE/dem"

# JSON-LD vocab document referenced by SIMU_CONTEXT["@vocab"] — bundles point
# at this URL, so it has to be present at every deploy or @vocab 404s.
mkdir -p "$STAGE/vocab"
cp vocab/simujoules.jsonld "$STAGE/vocab/"

# PWA assets: manifest, service worker, icons. The service worker has its
# own scope and must live at the deploy root for `scope: './'` to cover
# the whole app — don't move it into a subdirectory.
cp manifest.webmanifest "$STAGE/"
cp sw.js                "$STAGE/"
mkdir -p "$STAGE/icons"
cp icons/icon.svg               "$STAGE/icons/"
cp icons/icon-192.png           "$STAGE/icons/"
cp icons/icon-512.png           "$STAGE/icons/"
cp icons/icon-maskable-192.png  "$STAGE/icons/"
cp icons/icon-maskable-512.png  "$STAGE/icons/"
cp icons/apple-touch-icon.png   "$STAGE/icons/"

if ! command -v gsutil >/dev/null 2>&1; then
  echo "gsutil not on PATH. Install via the Google Cloud SDK." >&2
  exit 1
fi

# 3. Upload Flags:
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

# 4. Set headers. HTML gets a short cache so deploys propagate quickly,
#    JS gets an hour. Skip when nothing changed — the headers persist
#    from the previous deploy.
if [[ "$CHANGED" -eq 1 ]]; then
  echo ">> Setting headers…"
  gsutil -m setmeta \
    -h "Cache-Control: public, max-age=3600" \
    "$BUCKET/app.js" \
    "$BUCKET/energy-worker.js"

  # The vocab is consumed by RDF tools that content-negotiate; tag it as
  # application/ld+json (gsutil otherwise infers application/json from the
  # extension table). Long-lived cache because the vocab churns rarely.
  gsutil setmeta \
    -h "Content-Type: application/ld+json" \
    -h "Cache-Control: public, max-age=86400" \
    "$BUCKET/vocab/simujoules.jsonld"

  # PWA manifest: dedicated MIME type (browsers tolerate application/json
  # but the spec wants this one). Short cache because adding/removing icons
  # should propagate quickly.
  gsutil setmeta \
    -h "Content-Type: application/manifest+json" \
    -h "Cache-Control: public, max-age=3600" \
    "$BUCKET/manifest.webmanifest"

  # Service worker: must NOT be aggressively cached — browsers check this
  # file on every navigation to detect updates. With long caching, deploys
  # would take hours to propagate to existing installs. no-cache forces a
  # revalidation each time (it's tiny).
  gsutil setmeta \
    -h "Content-Type: application/javascript" \
    -h "Cache-Control: no-cache" \
    "$BUCKET/sw.js"

  # Icons: long cache, content-hashed by their path so we never overwrite
  # in place (rename + bump in manifest if you ever redesign).
  gsutil -m setmeta \
    -h "Cache-Control: public, max-age=2592000" \
    "$BUCKET/icons/icon.svg" \
    "$BUCKET/icons/icon-192.png" \
    "$BUCKET/icons/icon-512.png" \
    "$BUCKET/icons/icon-maskable-192.png" \
    "$BUCKET/icons/icon-maskable-512.png" \
    "$BUCKET/icons/apple-touch-icon.png"

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
