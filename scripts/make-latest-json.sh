#!/usr/bin/env bash
# Generate `latest.json` — the manifest tauri-plugin-updater fetches to decide
# whether a newer version exists, and to verify its signature.
#
# Run it right after a signed build:
#
#   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/nook.key)"
#   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
#   pnpm tauri build
#   bash scripts/make-latest-json.sh
#
# Then upload BOTH `Nook.app.tar.gz` and `latest.json` (plus the `.dmg` for new
# installs) to the GitHub Release tagged `v<version>`.
#
# NOTE: `TAURI_SIGNING_PRIVATE_KEY_PATH` is *not* honoured by the bundler — you
# must pass the key's contents in `TAURI_SIGNING_PRIVATE_KEY`. A build without it
# still exits 0 but silently produces no `.sig`, so we hard-fail here instead.
set -euo pipefail

REPO="hibiki1213/nook"
BUNDLE="src-tauri/target/release/bundle"
TARBALL="$BUNDLE/macos/Nook.app.tar.gz"
SIG_FILE="$TARBALL.sig"

VERSION=$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')

if [ ! -f "$SIG_FILE" ]; then
  echo "✗ $SIG_FILE not found." >&2
  echo "  The build produced no signature. Set TAURI_SIGNING_PRIVATE_KEY to the" >&2
  echo "  *contents* of ~/.tauri/nook.key and rebuild." >&2
  exit 1
fi

SIG=$(cat "$SIG_FILE")
PUB_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > "$BUNDLE/latest.json" <<EOF
{
  "version": "$VERSION",
  "notes": "See https://github.com/$REPO/releases/tag/v$VERSION",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIG",
      "url": "https://github.com/$REPO/releases/download/v$VERSION/Nook.app.tar.gz"
    }
  }
}
EOF

echo "✅ wrote $BUNDLE/latest.json (v$VERSION)"
echo
echo "Upload to the v$VERSION release:"
echo "  - $BUNDLE/dmg/Nook_${VERSION}_aarch64.dmg   (new installs)"
echo "  - $TARBALL                                   (updater payload)"
echo "  - $BUNDLE/latest.json                        (updater manifest)"
