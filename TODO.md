# TODO

## v0.2 — quality of life

- [ ] Auto-renumber on Enter inside an indexed block — insert `<prefix>_<n+1>=` at the new line and shift subsequent indices.
- [ ] Code action / quick fix on the duplicate-key diagnostic: "Renumber following lines".
- [ ] Preset validation pass:
  - missing `MILKDROP_PRESET_VERSION` (warn if shaders are present and version < 200)
  - missing `PSVERSION_COMP` / `PSVERSION_WARP` when comp/warp blocks exist
  - `[preset00]` section header present
- [ ] Outline view (DocumentSymbolProvider): per_frame block, per_pixel block, warp shader, comp shader, wavecodes, shapecodes.
- [ ] Hover help: show docs for built-in milkdrop variables (`zoom`, `rot`, `q1..q32`, `bass`, `mid`, `treb`, etc.) and expression functions (`if(a,b,c)`, `above`, `below`, `sigmoid`, …).

## v0.3 — embedded HLSL

- [x] HLSL **syntax-error** diagnostics in `warp_N`/`comp_N` blocks via the
      `tree-sitter-hlsl` grammar compiled to WASM (`wasm/tree-sitter-hlsl.wasm`),
      loaded at runtime with `web-tree-sitter`. See [src/hlsl.ts](src/hlsl.ts).
      Reassembles the block (strip backtick, stop at gap), rewrites the
      `shader_body { … }` wrapper into a real function, blanks legacy
      `= sampler_state { … }` initializers (grammar gap → false positives),
      parses, and reports the *first* error node per block (recovery cascade is
      noisy). Toggle: `milkdrop.shaderDiagnostics.enable`.
- [ ] Inject real HLSL **highlighting** inside `comp_N=\`` / `warp_N=\`` blocks
      (the diagnostics above don't colorize). Options:
  - rely on user having an HLSL extension installed (cheap, fragile)
  - ship a minimal HLSL TextMate grammar in this extension
- [ ] Make `lerp`, `tex2D`, `tex3D`, `GetVideo`, `GetBlur1/2/3`, `sampler_main`, `sampler_fw_video`, `aspect`, `texsize`, etc. completable inside shader blocks.
- [ ] Variable shadowing diagnostic across the *concatenated* comp/warp block (catch the `c, s` collision we hit in `999.milk`). Needs name resolution — tree-sitter gives the parse tree to build this on, but not the analysis itself.

## v0.4 — live preview

- [ ] `Milkdrop: Show Transpiled GLSL` command — call into projectM's HLSL→GLSL transpiler and open the result in a new editor.
- [ ] `Milkdrop: Preview Preset` command — spawn projectM-Test-UI with `PROJECTM_PRESET_LIST` set to a single-file list containing the current document.

## v1.0 — distribution

- [ ] Add an icon, marketplace metadata, screenshots.
- [ ] CI: GitHub Action that runs `tsc` and `vsce package` on push.
- [ ] Publish to the VS Code Marketplace and Open VSX.

## Cross-IDE (separate effort)

- [ ] Extract the smart features (renumber, diagnostics, completions, outline) into a standalone LSP server so JetBrains IDEs (CLion, IntelliJ) can use them too. The TextMate grammar already ports to CLion via Settings → Editor → TextMate Bundles.
