#!/bin/sh
# Stamp the current commit SHA into version.js while preserving the cache version.
set -eu
cd "$(dirname "$0")/.."
sha=$(git rev-parse --short HEAD)
cache=$(sed -n 's/.*APP_CACHE_VERSION = \([0-9][0-9]*\).*/\1/p' version.js)
[ -n "$cache" ] || cache=0
printf '%s\n' \
  '// Build metadata: stamped from git (see tools/stamp-version.sh).' \
  '// Loaded by both the page and the service worker so CACHE_NAME and the' \
  '// Settings display can never drift apart.' \
  "self.APP_VERSION = \"$sha\";" \
  "self.APP_CACHE_VERSION = $cache;" > version.js
printf 'version.js -> %s (cache v%s)\n' "$sha" "$cache"
