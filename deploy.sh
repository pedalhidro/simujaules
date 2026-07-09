#!/usr/bin/env bash
# Deploy the static site to gs://simujaules (served at the root of
# https://simujaules.pedalhidrografi.co/).
#
# Requires: the Google Cloud SDK authenticated against a project with write
# access to the gs://simujaules bucket. Uses `gcloud storage`, NOT `gsutil` — the
# bundled gsutil crashes with "module 'sys' has no attribute 'maxint'" on some
# SDK/Python installs and silently half-uploads (a stale, inconsistent bucket).
#
# CDN: simujaules.pedalhidrografi.co is fronted by CLOUDFLARE (origin = the GCS
# bucket directly), NOT Google Cloud CDN — so cache invalidation is a Cloudflare
# purge, not a url-map invalidation. Set these to enable it (skipped if unset):
#   export CF_API_TOKEN=...   # token with the Zone › Cache Purge permission
#   export CF_ZONE_ID=...     # zone id for pedalhidrografi.co
# Find the zone id in the Cloudflare dashboard (Overview, API box, right column)
# or:
#   curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
#     "https://api.cloudflare.com/client/v4/zones?name=pedalhidrografi.co" \
#     | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0]["id"])'
#
# Heads-up: Cloudflare can OVERRIDE origin Cache-Control via a zone "Browser
# Cache TTL". If the live sw.js doesn't return `Cache-Control: no-cache`, add a
# Cloudflare Cache Rule that bypasses cache for URI path ending in /sw.js (and
# set Browser Cache TTL to "Respect Existing Headers"), or SW updates stall.
#
# Usage: ./deploy.sh

set -euo pipefail

BUCKET="gs://simujaules"
PUBLIC_URL="https://simujaules.pedalhidrografi.co/"

cd "$(dirname "$0")"

if [[ $# -gt 0 ]]; then
  echo "deploy.sh takes no arguments; got: $*" >&2
  exit 2
fi

# 1. Stage the deploy. Keeps source-only files (QGIS plugins,
#    test harnesses, this script) out of the public bucket.
echo ">> Staging files…"
STAGE="$(mktemp -d)"
RSYNC_LOG="$(mktemp)"
CDN_ERR="$(mktemp)"
# Single EXIT trap for every temp path — a second `trap ... EXIT` would
# silently REPLACE the first one (the old script leaked the ~575 MB
# staging dir on every run because of exactly that).
trap 'rm -rf "$STAGE" "$RSYNC_LOG" "$CDN_ERR"' EXIT

cp index.html app.js energy-worker.js graph-engine.js favicon.ico "$STAGE/"
# Explicit glob rather than `cp -r dem/ ...` — BSD and GNU cp disagree on
# trailing-slash semantics (GNU nests a second dem/ level, breaking the
# example-DEM URLs hardcoded in app.js).
mkdir -p "$STAGE/dem"
cp dem/*.tif "$STAGE/dem/"

# JSON-LD vocab document referenced by SIMU_CONTEXT["@vocab"] — bundles point
# at this URL, so it has to be present at every deploy or @vocab 404s.
mkdir -p "$STAGE/vocab"
cp vocab/simujoules.jsonld "$STAGE/vocab/"

# The working paper (pt-BR + EN + PDFs + figures), served at /modelo/.
# Static output built by bicycling-energy-model's research/build-modelo.sh
# and committed here — regenerate there, don't hand-edit.
mkdir -p "$STAGE/modelo/figs"
cp modelo/index.html modelo/en.html modelo/artigo.pdf modelo/paper.pdf "$STAGE/modelo/"
cp modelo/figs/*.svg "$STAGE/modelo/figs/"

# SEO / LLM-crawler descriptors + the changelog (linked from llms.txt and
# index.html's noscript). sitemap.xml now lives at the subdomain root
# (https://simujaules.pedalhidrografi.co/sitemap.xml); still worth submitting it
# explicitly in Search Console.
cp llms.txt sitemap.xml CHANGELOG.md "$STAGE/"

# PWA assets: manifest, service worker, icons. The service worker has its
# own scope and must live at the deploy root for `scope: './'` to cover
# the whole app — don't move it into a subdirectory.
cp manifest.webmanifest "$STAGE/"
cp sw.js                "$STAGE/"
mkdir -p "$STAGE/icons"
cp icons/icon-v2.svg               "$STAGE/icons/"
cp icons/icon-192-v2.png           "$STAGE/icons/"
cp icons/icon-512-v2.png           "$STAGE/icons/"
cp icons/icon-maskable-192-v2.png  "$STAGE/icons/"
cp icons/icon-maskable-512-v2.png  "$STAGE/icons/"
cp icons/apple-touch-icon-v2.png   "$STAGE/icons/"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud not on PATH. Install the Google Cloud SDK." >&2
  exit 1
fi

# 3. Upload with `gcloud storage rsync`:
#    -r                                      recurse into dem/, icons/, vocab/.
#    --delete-unmatched-destination-objects  delete bucket objects not in the
#                                            staging dir (the whole dedicated
#                                            simujaules bucket) so renames
#                                            don't leave orphans.
#    --exclude='^(census|vector|mask|vm)(/|$)'  ...EXCEPT these OUT-OF-BAND
#                                            prefixes, uploaded by hand and read
#                                            directly by the app/orchestrator —
#                                            never staged here, so without the
#                                            exclude --delete-unmatched would
#                                            prune them on every deploy
#                                            (they 404 afterwards):
#                                              census/setores_br_pop.fgb (~454 MB,
#                                                CENSUS_FGB_URL, built by build_fgb.py)
#                                              vector/sampa-viario.gpkg (~145 MB,
#                                                "Viário RMSampa" example network)
#                                              mask/water_mask.tif (~2.4 MB,
#                                                "Águas RMSampa" example barrier mask)
#                                              vm/startup-script.sh (the cloud-compute
#                                                VM startup script, read by
#                                                orchestrator/main.py on VM create)
#                                            gcloud's --exclude is a Python regex
#                                            (re.match, start-anchored) on the
#                                            RELATIVE object path and is applied
#                                            to the DESTINATION listing too, so
#                                            matching bucket objects are removed
#                                            from the delete-candidate set — real
#                                            protection, not just a source skip.
#    --checksums-only                        compare by CRC32C, not mtime — the
#                                            staging dir gets fresh mtimes every
#                                            run, so without this every file
#                                            looks changed and re-uploads.
echo ">> Uploading to $BUCKET …"
gcloud storage rsync -r --checksums-only --delete-unmatched-destination-objects \
  --exclude='^(census|vector|mask|vm)(/|$)' \
  "$STAGE" "$BUCKET/" 2>&1 | tee "$RSYNC_LOG"

# 4. Set headers (metadata-only — cheap, so run every deploy). HTML gets a short
#    cache so deploys propagate quickly; JS an hour; the service worker no-cache
#    so browsers revalidate it every navigation and pick up updates. NB: a
#    Cloudflare "Browser Cache TTL" can override these (see the header note).
echo ">> Setting headers…"
gcloud storage objects update \
  "$BUCKET/app.js" "$BUCKET/energy-worker.js" "$BUCKET/graph-engine.js" \
  --cache-control="public, max-age=3600"

# The vocab is consumed by RDF tools that content-negotiate; tag it as
# application/ld+json. Long-lived cache because the vocab churns rarely.
gcloud storage objects update "$BUCKET/vocab/simujoules.jsonld" \
  --content-type="application/ld+json" --cache-control="public, max-age=86400"

# SEO descriptors: explicit content types (.md would otherwise be octet-stream)
# + modest caches.
gcloud storage objects update "$BUCKET/llms.txt" \
  --content-type="text/plain; charset=utf-8" --cache-control="public, max-age=3600"
gcloud storage objects update "$BUCKET/sitemap.xml" \
  --content-type="application/xml" --cache-control="public, max-age=86400"
gcloud storage objects update "$BUCKET/CHANGELOG.md" \
  --content-type="text/markdown; charset=utf-8" --cache-control="public, max-age=3600"

# PWA manifest: dedicated MIME type. Short cache so icon add/remove propagates.
gcloud storage objects update "$BUCKET/manifest.webmanifest" \
  --content-type="application/manifest+json" --cache-control="public, max-age=3600"

# Service worker: must NOT be aggressively cached — browsers check this file on
# every navigation to detect updates. no-cache forces a revalidation each time.
gcloud storage objects update "$BUCKET/sw.js" \
  --content-type="application/javascript" --cache-control="no-cache"

# Icons: long cache — filenames carry a "-v2"-style version suffix SPECIFICALLY
# so a redesign gets a new URL instead of colliding with this 30-day cache (see
# the v50->v51 icon change: it kept old filenames, so every browser/CDN that
# had cached the old bytes under this same max-age didn't see the new icon for
# up to 30 days regardless of redeploying). Next redesign: bump every filename
# here AND in manifest.webmanifest/index.html/sw.js's PRECACHE_URLS to "-v3".
gcloud storage objects update \
  "$BUCKET/icons/icon-v2.svg" "$BUCKET/icons/icon-192-v2.png" "$BUCKET/icons/icon-512-v2.png" \
  "$BUCKET/icons/icon-maskable-192-v2.png" "$BUCKET/icons/icon-maskable-512-v2.png" \
  "$BUCKET/icons/apple-touch-icon-v2.png" \
  --cache-control="public, max-age=2592000"

gcloud storage objects update "$BUCKET/index.html" \
  --cache-control="public, max-age=300"

# Favicon: explicit MIME (would otherwise be octet-stream). Unlike the other
# icons, browsers request this at a hardcoded well-known path (/favicon.ico) —
# it CANNOT be renamed to bust the cache, so its lifetime is short (1 day) on
# purpose, not long, so a future favicon change actually propagates.
gcloud storage objects update "$BUCKET/favicon.ico" \
  --content-type="image/x-icon" --cache-control="public, max-age=86400"

# 5. Purge Cloudflare's cache for the deployed URLs (Cloudflare fronts the site,
#    so this is a CF cache purge — there is no Google Cloud CDN url-map). Purges
#    the EXACT URLs just staged (works on every CF plan; prefix purge is
#    Enterprise-only). The list is derived from the staging dir, so it stays in
#    sync automatically and never exceeds the 30-URL per-request limit here.
#    Skipped — with a notice — when CF_API_TOKEN / CF_ZONE_ID aren't set.
if [[ -n "${CF_API_TOKEN:-}" && -n "${CF_ZONE_ID:-}" ]]; then
  echo ">> Purging Cloudflare cache…"
  # "" → the bare directory URL (serves index.html); then every staged file.
  PURGE_JSON=""
  for rel in "" $(cd "$STAGE" && find . -type f | sed 's|^\./||'); do
    PURGE_JSON+="\"${PUBLIC_URL}${rel}\","
  done
  PURGE_JSON="[${PURGE_JSON%,}]"
  if ! curl -fsS -X POST \
        "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" \
        -H "Content-Type: application/json" \
        --data "{\"files\":${PURGE_JSON}}" >"$CDN_ERR" 2>&1; then
    echo
    echo "WARNING: Cloudflare purge failed. Output:"
    cat "$CDN_ERR"
    echo
    echo "Check the token has Zone › Cache Purge on pedalhidrografi.co and that"
    echo "CF_ZONE_ID is correct (see the header of this script for how to find it)."
  else
    echo "   Cloudflare cache purged."
  fi
else
  echo ">> CF_API_TOKEN / CF_ZONE_ID not set — skipping Cloudflare purge."
  echo "   sw.js is no-cache so it self-revalidates and pulls the new build, but"
  echo "   cached HTML/JS at the edge persists until its TTL. Export the two vars"
  echo "   (see this script's header) to purge automatically on each deploy."
fi

echo
echo ">> Done."
echo "   Live at $PUBLIC_URL"
