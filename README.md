# vscode-milkdrop

VS Code language support for Milkdrop `.milk` preset files.

## Features

- **Syntax highlighting** for sections, indexed keys (`comp_N=`, `warp_N=`, `per_frame_N=`, `per_pixel_N=`), HLSL inside shader backtick blocks, expression keywords, and numerics.
- **Renumber command** (`Milkdrop: Renumber Indexed Blocks`, default `cmd+alt+r` / `ctrl+alt+r`) — rewrites every `<prefix>_N=` line so each prefix is numbered 1..N in source order. Fixes the common bug where duplicate keys silently overwrite each other.
- **Duplicate-key diagnostic** — warns live as you type when two lines share the same `<prefix>_N=` key.
- **Smart line-start completions** — typing on a fresh line suggests the next available `comp_<n>=\``, `warp_<n>=\``, `per_frame_<n>=`, etc., auto-incremented from the highest existing index.

## Development

```bash
npm install
npm run compile      # one-shot build
npm run watch        # incremental
```

Then open this folder in VS Code and press `F5` to launch an Extension Development Host with the extension loaded.

## Origin

Built alongside the [projectM](https://github.com/projectM-visualizer/projectm) visualizer to make hand-editing Milkdrop presets less painful.
