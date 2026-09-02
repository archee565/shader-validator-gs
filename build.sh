#!/bin/bash
set -e
./download-server.sh
npm run compile
npm run package
vsce package
code --install-extension shader-validator-gs-*.vsix
