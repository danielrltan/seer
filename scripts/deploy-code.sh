#!/bin/bash
# Deploys Seer's own code (bin, src, assets, node_modules) to ~/.seer/code, where Seer.app runs it from, and
# restarts the Seer service so it takes effect (Seer.app restarts it within seconds). The app bundle is not
# touched, so macOS keeps its Screen Recording and Accessibility permissions.
# Usage: scripts/deploy-code.sh [--no-restart]
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${SEER_HOME:-$HOME/.seer}/code"
mkdir -p "$DEST"
rsync -a --delete --exclude '.DS_Store' --exclude 'src/app' --exclude 'src/helpers' bin src assets node_modules package.json "$DEST/"
echo "deployed code to $DEST"
if [ "${1:-}" != "--no-restart" ]; then
  pkill -f 'seer.js daemon' && echo "restarted the Seer service" || echo "Seer service not running (open Seer.app)"
fi
