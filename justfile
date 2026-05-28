build:
    npm run compile

# Regenerate the bundled tree-sitter-hlsl grammar (committed; only needed after
# bumping tree-sitter-hlsl). Downloads the WASI SDK on first run.
wasm:
    npm run build:wasm

package:
    npm run compile
    npx @vscode/vsce package
