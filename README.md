# vscode-milkdrop

VS Code language support for Milkdrop `.milk` preset files.

## Features

- **Syntax highlighting** for sections, indexed keys (`comp_N=`, `warp_N=`, `per_frame_N=`, `per_pixel_N=`), HLSL inside shader backtick blocks, expression keywords, and numerics.
- **Renumber command** (`Milkdrop: Renumber Indexed Blocks`, default `cmd+alt+r` / `ctrl+alt+r`) — rewrites every `<prefix>_N=` line so each prefix is numbered 1..N in source order. Fixes the common bug where duplicate keys silently overwrite each other.
- **Duplicate-key diagnostic** — warns live as you type when two lines share the same `<prefix>_N=` key (projectM keeps the first; the later line is dropped at load time).
- **Gap-truncation diagnostic** — warns when a block has a missing index (e.g. a duplicate leaves `comp_5` absent): projectM stops at the first gap, so every higher-numbered line is silently dropped at load time. Run the renumber command to close the gap.
- **Smart line-start completions** — typing on a fresh line suggests the next available `comp_<n>=\``, `warp_<n>=\``, `per_frame_<n>=`, etc., auto-incremented from the highest existing index.
- **HLSL shader syntax diagnostics** — the `warp_`/`comp_` blocks are reassembled and parsed with the [tree-sitter-hlsl](https://github.com/tree-sitter-grammars/tree-sitter-hlsl) grammar (compiled to WebAssembly), flagging structural errors like a missing `;` or `}`. Syntax only — undeclared MilkDrop uniforms/samplers are not errors. Toggle with the `milkdrop.shaderDiagnostics.enable` setting.

## Development

```bash
npm install
npm run compile      # one-shot build
npm run watch        # incremental
```

Then open this folder in VS Code and press `F5` to launch an Extension Development Host with the extension loaded.

### Rebuilding the HLSL grammar

The bundled `wasm/tree-sitter-hlsl.wasm` is prebuilt and committed, so a normal
`npm install` + `npm run compile` is enough. To regenerate it (e.g. after
bumping `tree-sitter-hlsl`):

```bash
npm run build:wasm   # needs the tree-sitter CLI; downloads the WASI SDK on first run
```

## Packaging

Packaging produces a `.vsix` file using [`@vscode/vsce`](https://github.com/microsoft/vscode-vsce):

```bash
npm install
npm run compile
npx @vscode/vsce package      # -> vscode-milkdrop-<version>.vsix
```

The `.vsix` bundles the compiled `out/`, the grammar `wasm/`, and the
`web-tree-sitter` runtime (see `.vscodeignore` for what is excluded). `vsce`
will warn about a missing repository field or icon — those are optional for
local installs.

## Installing

Install the packaged `.vsix` into VS Code in either way:

- **CLI:** `code --install-extension vscode-milkdrop-<version>.vsix`
- **UI:** Extensions view → `…` menu → *Install from VSIX…* → pick the file.

Then reload the window (`Developer: Reload Window`). Open any `.milk` file to
activate the extension. To uninstall, find "Milkdrop Preset Language Support" in
the Extensions view and remove it.

## Origin

Built alongside the [projectM](https://github.com/projectM-visualizer/projectm) visualizer to make hand-editing Milkdrop presets less painful.
