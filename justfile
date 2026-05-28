build:
    npm run compile

# Regenerate the bundled tree-sitter-hlsl grammar (committed; only needed after
# bumping tree-sitter-hlsl). Downloads the WASI SDK on first run.
wasm:
    npm run build:wasm

package:
    npm run compile
    npx @vscode/vsce package

# Build and install the extension globally into VS Code (overwrites any
# existing install of the same version). Falls back to the macOS app-bundle
# path when the `code` CLI isn't on PATH.
install: package
    #!/usr/bin/env sh
    set -e
    code_cli="$(command -v code || true)"
    if [ -z "$code_cli" ] && [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
        code_cli="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    fi
    if [ -z "$code_cli" ]; then
        echo "error: VS Code 'code' CLI not found on PATH or in /Applications" >&2
        exit 1
    fi
    "$code_cli" --install-extension "vscode-milkdrop-$(node -p "require('./package.json').version").vsix" --force
