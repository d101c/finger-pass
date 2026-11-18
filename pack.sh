#!/usr/bin/env bash
# Builds finger-pass@griffit.gmail.com.shell-extension.zip in the repo root.
# Install it with: gnome-extensions install --force <zip>
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO/extension"

gnome-extensions pack "$SRC" \
  --extra-source=dialog.js \
  --extra-source=fprintd.js \
  --extra-source=glyph.js \
  --extra-source=model.js \
  --extra-source=pam.js \
  --extra-source=LICENSE \
  --podir=po \
  --gettext-domain=finger-pass \
  --out-dir="$REPO" \
  --force

echo "Built: $REPO/finger-pass@griffit.gmail.com.shell-extension.zip"
