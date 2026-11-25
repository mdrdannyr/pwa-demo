#!/bin/sh
# Stamp the current commit SHA into version.js so the Settings page can show it.
set -eu
cd "$(dirname "$0")/.."
sha=$(git rev-parse --short HEAD)
printf '// Stamped from `git rev-parse --short HEAD` (see tools/stamp-version.sh).\nwindow.APP_VERSION = "%s";\n' "$sha" > version.js
printf 'version.js -> %s\n' "$sha"
