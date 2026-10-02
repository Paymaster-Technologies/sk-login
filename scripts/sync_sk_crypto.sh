#!/usr/bin/env bash
# Syncs the envelope cryptography from the Secret Keeper repo (the extension's
# port to @noble/*, works in Node as is). A copy, not a dependency: two files.
# Drift is caught by packages/core/test/crypto.test.ts on fixtures recorded
# by the app itself (extension/test/fixtures/app_fixtures.json).
#
#   ./scripts/sync_sk_crypto.sh [path to the secret_keeper repo]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
sk="${1:-$here/../secret_keeper}"
src="$sk/extension/src/crypto"
[ -f "$src/envelope.ts" ] || { echo "no $src/envelope.ts" >&2; exit 1; }
cp "$src/envelope.ts" "$src/identity.ts" "$here/packages/core/src/crypto/"
cp "$sk/extension/test/fixtures/app_fixtures.json" "$here/packages/core/test/fixtures/"
rev="$(git -C "$sk" rev-parse --short HEAD)"
printf 'secret_keeper %s\n' "$rev" > "$here/packages/core/src/crypto/SYNCED_FROM"
echo "synced from secret_keeper $rev"
