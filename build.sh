#!/bin/bash
set -e
npm run compile
npm run package
vsce package
code --install-extension shader-validator-gs-*.vsix
