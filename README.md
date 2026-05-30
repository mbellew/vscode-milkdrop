# vscode-milkdrop

VS Code language support for Milkdrop `.milk` preset files.

## Features

### Highlighting

- **Syntax highlighting** for sections, indexed keys (`per_frame_N=`, `per_pixel_N=`, `warp_N=`, `comp_N=`, `wave_<N>_*`, `shape_<N>_*`), HLSL inside shader backtick blocks, and numerics.
- **Built-in highlighting** (semantic tokens) — engine-provided variables (`time`, `bass`, `q1..q32`, …), functions (`sin`, `if`, …), and recognised config keys (`fDecay`, `zoom`, `wavecode_0_samples`, …) are coloured distinctly, per execution pool. Because `.milk` auto-declares any bare name, a misspelled built-in silently reads as `0`; here it simply *loses* its colour and stands out. A scope fallback keeps it visible even in sparse themes that don't theme semantic tokens. Toggle: `milkdrop.semanticHighlighting.enable`.

### Diagnostics (live as you type)

- **Expression syntax** — per-frame/per-pixel/wave/shape code is parsed by a reimplementation of projectM's `projectm-eval` compiler, flagging unbalanced parens, stray tokens, unknown function calls, and wrong argument counts. Toggle: `milkdrop.expressionDiagnostics.enable`.
- **Read but never written** — warns when a non-built-in variable is read but never assigned anywhere in its pool, so it can only evaluate to `0` — usually a typo, or a value wrongly expected to carry across pools (only `q1..q32` / `t1..t8` / `reg00..reg99` do). Toggle: `milkdrop.undefinedReadDiagnostics.enable`.
- **HLSL shader syntax** — `warp_`/`comp_` blocks are reassembled and parsed with the [tree-sitter-hlsl](https://github.com/tree-sitter-grammars/tree-sitter-hlsl) grammar (compiled to WebAssembly), flagging structural errors like a missing `;` or `}`. Syntax only — undeclared MilkDrop uniforms/samplers are not errors. Toggle: `milkdrop.shaderDiagnostics.enable`.
- **Duplicate key** — warns when two lines share the same `<prefix>_N=` key (projectM keeps the first; the later line is dropped at load time).
- **Gap truncation** — warns when a block has a missing index: projectM stops at the first gap, so every higher-numbered line is silently dropped at load time. Comment-only lines past the gap aren't flagged (nothing is lost). Run the renumber command to close it.

### Editing

- **Renumber command** (`Milkdrop: Renumber Indexed Blocks`, default `cmd+alt+r` / `ctrl+alt+r`) — rewrites every indexed block so each prefix is numbered 1..N in source order, closing gaps and resolving the duplicate-overwrite bug.
- **Smart line-start completions** — typing on a fresh line suggests the next available `per_frame_<n>=`, `warp_<n>=\``, `comp_<n>=\``, etc., auto-incremented from the highest existing index.

### AI assistance

- **Chat instructions** — ships a `.milk` editing guide (via `contributes.chatInstructions`) that VS Code chat attaches automatically when a `.milk` file is in context, so AI assistants follow the format's rules (index gaps, separate variable pools, the backtick shader convention, …).

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

Download the latest `vscode-milkdrop-<version>.vsix` from the
[**Releases** page](https://github.com/mbellew/vscode-milkdrop/releases/latest)
(or build your own with [Packaging](#packaging) above), then install it into VS
Code in either way:

- **CLI:** `code --install-extension vscode-milkdrop-<version>.vsix`
- **UI:** Extensions view → `…` menu → *Install from VSIX…* → pick the file.

Then reload the window (`Developer: Reload Window`). Open any `.milk` file to
activate the extension. To uninstall, find "Milkdrop Preset Language Support" in
the Extensions view and remove it.

## Origin

Built alongside the [projectM](https://github.com/projectM-visualizer/projectm) visualizer to make hand-editing Milkdrop presets less painful.
