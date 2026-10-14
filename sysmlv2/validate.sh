#!/usr/bin/env bash
# Validate every sysmlv2/*.sysml with the OMG SysML v2 Pilot Implementation
# (no license key needed). Uses a local `java`/`javac` (>= 17) if present,
# otherwise Docker (eclipse-temurin:21-jdk). The pilot kernel is downloaded
# once into a cache dir — it is NOT vendored in the repo.
#
#   ./sysmlv2/validate.sh                 # all files
#   PILOT_RELEASE=2026-08 PILOT_VERSION=0.62.0 ./sysmlv2/validate.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
rel="${PILOT_RELEASE:-2026-08}"
ver="${PILOT_VERSION:-0.62.0}"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/simujaules-sysml/$ver"
if [ ! -f "$cache/sysml/jupyter-sysml-kernel-$ver-all.jar" ]; then
  mkdir -p "$cache"
  echo "Downloading SysML v2 Pilot kernel $ver ..." >&2
  curl -fsSL -o "$cache/k.zip" \
    "https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation/releases/download/$rel/jupyter-sysml-kernel-$ver.zip"
  (cd "$cache" && unzip -q -o k.zip)
fi
mkdir -p "$cache/drv"
files=()
for f in "$here"/*.sysml; do files+=("$(basename "$f")"); done
filter() { grep -v -E '^(Reading |log4j|SysML v2 Pilot)' || true; }
if command -v javac >/dev/null && command -v java >/dev/null; then
  [ "$cache/drv/Validate.class" -nt "$here/tools/Validate.java" ] ||
    javac -d "$cache/drv" -cp "$cache/sysml/*" "$here/tools/Validate.java"
  (cd "$here" && java -cp "$cache/drv:$cache/sysml/*" Validate "$cache/sysml/sysml.library" "${files[@]}") 2>&1 | filter
  exit "${PIPESTATUS[0]}"
fi
img=eclipse-temurin:21-jdk
run() { docker run --rm -v "$cache:/c" -v "$here:/m:ro" -w /m "$img" "$@"; }
[ "$cache/drv/Validate.class" -nt "$here/tools/Validate.java" ] ||
  run javac -d /c/drv -cp '/c/sysml/*' /m/tools/Validate.java
set +e
run java -cp '/c/drv:/c/sysml/*' Validate /c/sysml/sysml.library "${files[@]}" 2>&1 | filter
exit "${PIPESTATUS[0]}"
