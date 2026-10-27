#!/bin/bash
set -e

cd "$(dirname "$0")"

# Use the vsce pinned in devDependencies instead of a global install.
VSCE=./node_modules/.bin/vsce
if [ ! -x "$VSCE" ]; then
    echo "vsce not found at $VSCE - run 'npm ci' first." >&2
    exit 1
fi

./download-server.sh
npm run compile
npm run package
"$VSCE" package
code --install-extension shader-validator-gs-*.vsix
