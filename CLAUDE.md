# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VS Code extension providing HLSL/GLSL/WGSL shader language support via LSP. The language server is a separate Rust binary ([antaalt/shader-sense](https://github.com/antaalt/shader-sense)) downloaded at build time — this repo only contains the VS Code extension client.

## Build Commands

```bash
npm run compile          # Development build (webpack)
npm run watch            # Watch mode
npm run package          # Production build (hidden source maps)
npm run lint             # ESLint
npm test                 # Integration tests (downloads VS Code automatically)
npm run test-wasi        # Integration tests using WASI server
```

Tests require a running display. CI uses `xvfb-run` on Linux. The `USE_WASI_SERVER=true` env var switches tests to the WASI server path.

The `pretest` script runs both webpack and `tsc -p . --outDir out` (tests use the `out/` directory, not `dist/`).

## Architecture

**Dual-target extension**: Webpack produces two bundles — `dist/node/` (Node.js stdio transport) and `dist/web/` (webworker with WASI transport). `package.json` points `main` and `browser` at these respectively.

**Server transport abstraction**: `ShaderLanguageClient` in `src/client.ts` creates either a stdio-spawned native server or a WASM/WASI server depending on platform and settings. Platform detection: Windows x64/arm64 and Linux x64 use native binaries; everything else (macOS, ARM Linux, web) falls back to WASI.

**Server binary resolution**: The `ServerVersion` class checks `shader-validator-gs.serverPath` setting, then `SHADER_LANGUAGE_SERVER_EXECUTABLE_PATH` env var, then bundled binaries in `bin/{platform}/`. Binaries are not in git — CI downloads them from the shader-sense GitHub releases.

**Shader variant system**: `ShaderVariantTreeDataProvider` (`src/view/`) manages a sidebar tree where users define shader variants with entry points, stages, defines, and includes. Only one variant can be active globally. Active variant is sent to the server via a custom LSP notification (`textDocument/didChangeShaderVariant`). Variants persist in workspace state (Memento).

**Custom LSP requests**: `src/request.ts` defines debug requests (`debug/dumpAst`, `debug/dumpDependency`). The variant notification and request types are defined inline in `shaderVariantTreeView.ts`.

**Middleware**: `getMiddleware()` in `client.ts` intercepts `provideDocumentSymbols` to feed entry points to the variant tree, and intercepts `workspace/configuration` to resolve VS Code variables in include paths.

**WASI transport**: `src/wasm-wasi-lsp.ts` adapts `@vscode/wasm-wasi` streams to `vscode-languageclient`'s `ReadableStream`/`WritableStream` interfaces. URI converters map workspace folders to `/workspace/` paths for the WASI sandbox.

## Key Conventions

- TypeScript strict mode, targeting ES2022 with Node16 module resolution
- Test files in `src/test/suite/*.test.ts` use Mocha TDD style (`suite`/`test`)
- Test fixtures in `test/` directory: `test.frag.glsl`, `test.hlsl`, `test.wgsl`
- ESLint with `@typescript-eslint`
- All LSP communication uses `vscode-languageclient` (v10.x, next branch)
