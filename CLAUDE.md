# CLAUDE.md — vscode-milkdrop

Reference material for evolving the Milkdrop `.milk` language extension. Pulled from:

- Geiss's authoring guide: <https://www.geisswerks.com/milkdrop/milkdrop_preset_authoring.html>
- projectM `MILKDROP.md`: <https://github.com/projectM-visualizer/projectm/blob/master/MILKDROP.md>
- projectM parser (the ground truth): <https://github.com/projectM-visualizer/projectm/blob/master/src/libprojectM/MilkdropPreset/PresetFileParser.cpp>
- Parser header: <https://github.com/projectM-visualizer/projectm/blob/master/src/libprojectM/MilkdropPreset/PresetFileParser.hpp>
- Example presets: <https://github.com/projectM-visualizer/presets-cream-of-the-crop>

The projectM source tree is checked out locally at `../projectm`; sample presets are at `../projectm/cmake-build/presets/`. Use those for spot-checks instead of fetching from GitHub.

---

## 1. The format in one paragraph

A `.milk` file is a flat list of case-insensitive `key=value` (or `key value`) lines. No sections, no nesting, no escaping — the `[preset00]` line at the top is *literally ignored* by the parser. Order doesn't affect parsing; it only affects how MilkDrop saves the file back. Long blocks of code (per-frame equations, custom waves, shaders) are split across many numbered keys, gathered back together at load time by appending `1`, `2`, `3`, … to a prefix until the first missing number. Shader lines additionally carry a leading backtick on the value that gets stripped during reassembly. That's the whole format.

## 2. The parser, exactly

[projectM `PresetFileParser.cpp`](https://github.com/projectM-visualizer/projectm/blob/master/src/libprojectM/MilkdropPreset/PresetFileParser.cpp) is short and authoritative. The shape:

```cpp
// pseudo-summary of ParseLine
auto delim = line.find_first_of(" =");        // FIRST space OR '='
if (delim == npos || delim == 0) return;      // skip
key   = ToLower(line[0 .. delim));            // keys are lowercased
value = line[delim+1 .. end);                 // everything after the delimiter
if (key not already in map) map.emplace(key, value);  // FIRST OCCURRENCE WINS
```

Consequences that matter for the extension:

| Rule | Implication |
|------|-------------|
| Delimiter is **first** ` ` or `=`. | A line like `name=My Cool Preset` works (value is `My Cool Preset`). A line like `name My Cool Preset` *also* works (value is `My Cool Preset`). A key cannot contain a space. |
| Keys are lowercased before lookup. | `MILKDROP_PRESET_VERSION` and `milkdrop_preset_version` are the same key. Casing in the file is decorative. |
| **First occurrence wins** for duplicates. | This is the opposite of what the README/diagnostic currently claim. If `per_frame_3` appears twice, the **first one is kept** and the second is silently dropped. Update the diagnostic message accordingly. |
| `\r` and `\n` both end a line. | CRLF/LF/CR all fine. |
| Lines with no `=` and no space get skipped. | This is how `[preset00]`, blank lines, and stray junk become harmless. |
| Lines starting with `=` or ` ` are skipped. | Don't trip on accidentally-indented keys; they're errors but silent ones. |
| 1 MB hard limit, NUL byte aborts the load. | Sanity-only. |

### `GetCode(prefix)` — how multi-line blocks are reassembled

```cpp
for (int i = 1; i <= 99999; ++i) {
    auto it = map.find(prefix + std::to_string(i));
    if (it == end) break;                  // STOP AT FIRST GAP
    line = it->second;
    if (!line.empty() && line[0] == '`')
        line.erase(0, 1);                  // strip ONE leading backtick
    out << line << '\n';
}
```

- Iteration starts at `1`, not `0`.
- **A gap truncates the block.** If you have `per_frame_1`, `per_frame_2`, `per_frame_4`, only 1 and 2 are loaded. This is the bug the renumber command exists to fix.
- The backtick is stripped per-line — that's how a `comp_N=` line carries embedded HLSL.
- The prefix passed in includes the trailing underscore (`"per_frame_"`, `"warp_"`, `"comp_"`, `"wave_0_per_point"` — see §5 for the exact prefix list).

Comments (`//` and `\\` to end of line) are stripped *later*, by the expression/shader compiler — not by `PresetFileParser`. The parser preserves them in the stored value.

## 3. File layout

A modern (v2+) preset looks like:

```ini
MILKDROP_PRESET_VERSION=201
PSVERSION=2
PSVERSION_WARP=2
PSVERSION_COMP=2
[preset00]
<scalar config keys>             ; fDecay, zoom, wave_r, …
<per_frame_init_N=…>             ; one-shot init for q/user vars
<per_frame_N=…>                  ; runs every frame
<per_pixel_N=…>                  ; runs per mesh vertex (legacy name)
<wavecode_N_*=…>                 ; static config for custom waves
<wave_N_per_frameN=…>            ; custom wave per-frame code  (NO underscore before index)
<wave_N_per_pointN=…>            ; custom wave per-point code
<shapecode_N_*=…>                ; static config for custom shapes
<shape_N_per_frame_initN=…>      ; custom shape init code
<shape_N_per_frameN=…>           ; custom shape per-frame code
<warp_N=`…>                      ; HLSL warp shader, one source line per key
<comp_N=`…>                      ; HLSL composite shader, one source line per key
```

The `[preset00]` and version headers are conventional, not required by the parser. Pre-v2 presets often skip them entirely. Don't enforce their presence except as a soft warning if shaders are present and version < 200.

## 4. The two key-naming conventions (a footgun)

This is the one piece you have to get right. There are **two** indexing patterns and they're easy to confuse.

### Pattern A — underscore between suffix and index

```
per_frame_init_1=…
per_frame_1=…
per_pixel_1=…
warp_1=`…
comp_1=`…
```

Regex: `^(per_frame_init|per_frame|per_pixel|warp|comp)_(\d+)=`

### Pattern B — NO underscore between suffix and index

```
wave_0_per_frame1=…
wave_0_per_point1=…
shape_0_per_frame1=…
shape_0_per_frame_init1=…
```

Regex: `^(wave|shape)_(\d+)_(per_frame_init|per_frame|per_point)(\d+)=`

Why: the *outer* number is the wave/shape index (0–3); the *inner* number is the code line index. Whoever wrote the original format chose to elide the underscore on the inner one. The extension's current `INDEXED_LINE_RE` only covers Pattern A and silently ignores all custom-wave/shape code lines — they don't get renumbered, don't get duplicate diagnostics, don't get completions. Either add Pattern B explicitly or generalize.

There's also a third, simpler pattern for the static config of waves/shapes (no code, just scalars):

```
wavecode_0_enabled=1
wavecode_0_samples=512
wavecode_0_r=1.0
shapecode_0_sides=64
shapecode_0_rad=0.3
```

These aren't indexed code lines, they're plain config — leave them alone for renumber purposes.

## 5. The complete prefix table

What the projectM source actually calls `GetCode()` on, with full prefix strings (note trailing underscore presence/absence):

| Stage | Prefix passed to `GetCode` | On-disk key form |
|---|---|---|
| Per-frame init | `per_frame_init_` | `per_frame_init_1=`, … |
| Per-frame | `per_frame_` | `per_frame_1=`, … |
| Per-vertex | `per_pixel_` | `per_pixel_1=`, … (named `per_pixel` for historical reasons; it's per-vertex) |
| Warp shader | `warp_` | `warp_1=\``, … (HLSL, one source line per key) |
| Composite shader | `comp_` | `comp_1=\``, … |
| Custom wave per-frame | `wave_<N>_per_frame` | `wave_0_per_frame1=`, … |
| Custom wave per-point | `wave_<N>_per_point` | `wave_0_per_point1=`, … |
| Custom shape init | `shape_<N>_per_frame_init` | `shape_0_per_frame_init1=`, … |
| Custom shape per-frame | `shape_<N>_per_frame` | `shape_0_per_frame1=`, … |

`<N>` is `0..3` (max four custom waves, four custom shapes). The inner index runs `1..` and **stops at the first gap**.

## 6. Scalar config keys

These are the "knobs" — plain `key=value` numbers (almost always floats or 0/1 ints). MilkDrop tolerates unknown keys, so misspellings are silent footguns. The taxonomy below comes from projectM's `MILKDROP.md` and the parser code. Hungarian-prefix conventions:

- `f…` — float
- `n…` — int
- `b…` — bool (0 or 1)
- a few lowercase shortcuts (`zoom`, `rot`, `cx`, `cy`, `dx`, `dy`, `sx`, `sy`, `warp`, `wave_r`, `wave_g`, …) that pre-date the prefix scheme

### Image processing / decay

`fDecay`, `fGammaAdj`, `fVideoEchoZoom`, `fVideoEchoAlpha`, `nVideoEchoOrientation` (0–3),
`bBrighten`, `bDarken`, `bSolarize`, `bInvert`, `bDarkenCenter`, `bTexWrap`, `bRedBlueStereo`,
`fShader` (0..1 blend between v1 image-ops path and the warp shader)

### Motion

`zoom`, `fZoomExponent`, `rot`, `warp`, `fWarpAnimSpeed`, `fWarpScale`,
`cx`, `cy` (center of zoom/rot, 0..1),
`dx`, `dy` (translation), `sx`, `sy` (scaling)

### Built-in waveform

`nWaveMode` (0–7), `wave_r`, `wave_g`, `wave_b`, `wave_x`, `wave_y`, `wave_mystery`/`fWaveParam`,
`fWaveAlpha`, `fWaveScale`, `fWaveSmoothing`, `bAdditiveWaves`, `bWaveDots`, `bWaveThick`,
`bMaximizeWaveColor`, `bModWaveAlphaByVolume`, `fModWaveAlphaStart`, `fModWaveAlphaEnd`

### Borders

`ob_size`, `ob_r`, `ob_g`, `ob_b`, `ob_a` (outer),
`ib_size`, `ib_r`, `ib_g`, `ib_b`, `ib_a` (inner)

### Motion vectors

`nMotionVectorsX`, `nMotionVectorsY`, `mv_dx`, `mv_dy`, `mv_l`, `mv_r`, `mv_g`, `mv_b`, `mv_a`

### Blur thresholds (shader-stage blur textures)

`b1n`/`blur1_min`, `b1x`/`blur1_max`, `b1ed`/`blur1_edge_darken`,
`b2n`/`blur2_min`, `b2x`/`blur2_max`,
`b3n`/`blur3_min`, `b3x`/`blur3_max`

### Metadata / versioning

`MILKDROP_PRESET_VERSION` (100 = v1, 200/201 = v2 with shaders),
`PSVERSION`, `PSVERSION_WARP`, `PSVERSION_COMP` (2 = SM2.0 with 64-instruction limit, 3 = SM3.0),
`fRating` (user rating, 0–5, decorative)

## 7. The expression language (per-frame, per-pixel, wave, shape code)

A small EEL-style expression language. Statements separated by `;`. Assignment is `=`. Compound assignment: `+=`, `-=`, `*=`, `/=`. Operators: `+ - * / %`. No real control flow — branching is done with the `if()` function, which evaluates **both arms** (it's an expression, not a control-flow construct).

### Built-in functions

| Function | Notes |
|---|---|
| `if(cond, a, b)` | `cond > 0 ? a : b`. Both `a` and `b` are always evaluated. |
| `above(a, b)`, `below(a, b)`, `equal(a, b)` | Return 0 or 1. The 0/1-returning forms are preferred to comparison operators (which exist but feel unidiomatic). |
| `band(a, b)`, `bor(a, b)`, `bnot(a)` | Boolean ops on 0/1. |
| `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2` | Trig. `atan2(y, x)`. |
| `sqrt`, `pow`, `exp`, `log`, `log10` | |
| `abs`, `sign`, `floor`, `ceil`, `int` | `int` truncates toward zero. |
| `min(a,b)`, `max(a,b)` | |
| `sqr(x)` | `x*x`. |
| `rand(x)` | Uniform `[0, x)`. |
| `sigmoid(x, y)` | `1 / (1 + exp(-x*y))`. |
| `loop(count, expr)` | Repeats `expr` `count` times. The body sees no loop variable; use `megabuf` / counters. |
| `megabuf(idx)`, `gmegabuf(idx)` | Large indexed scratch arrays. `gmegabuf` is global across all pools. |

### Variable pools

The execution stages have **separate** variable scopes ("pools"). User-defined variables don't cross pools. The only carriers are:

- **`q1`..`q32`** — set in `per_frame_*`, readable in `per_pixel`, custom wave/shape code, and **also passed into shaders** as `q1`..`q32` (and grouped as `_qa`..`_qh` float4s). Reset to whatever the per-frame init left at the start of each frame.
- **`t1`..`t8`** — local to a single custom wave or custom shape's chain (init → per-frame → per-point).

### Read-only context variables

| Stage | Adds (on top of previous stages) |
|---|---|
| All stages | `time`, `fps`, `frame`, `progress`, `bass`, `mid`, `treb`, `bass_att`, `mid_att`, `treb_att`, `meshx`, `meshy`, `pixelsx`, `pixelsy`, `aspectx`, `aspecty` |
| `per_pixel` | `x`, `y` (0..1), `rad` (0..1), `ang` (0..2π) |
| Custom wave per-point | `sample` (0..1 along the waveform), `value1`, `value2` (left/right audio sample) |
| Custom shape per-frame | `instance` (0..num_inst-1) |

### Writable parameters

Per-frame code can write to any scalar config name (see §6) — that's how a preset animates `zoom`, `rot`, `wave_r`, etc. Per-vertex code receives those as starting values and can override per-vertex.

Custom wave/shape code can write the wave/shape's own params (`r`, `g`, `b`, `a`, `samples`, `x`, `y`, `rad`, `ang`, `sides`, `thick`, …) plus its own `q`/`t` vars.

## 8. Shader stages (warp and comp)

Modern presets (`MILKDROP_PRESET_VERSION >= 200`) carry two HLSL pixel shaders:

- **Warp** runs per mesh vertex's sample of the previous frame and writes the new framebuffer.
- **Composite** runs on the warped framebuffer for final post-processing (gamma, color tweaks, motion vectors, etc.).

### Source assembly

Each line of HLSL is one preset key. The value begins with a backtick that the parser strips. So `comp_1=\`shader_body` becomes `shader_body\n` in the assembled source.

```
warp_1=`shader_body
warp_2=`{
warp_3=`    ret = tex2D(sampler_main, uv).xyz;
warp_4=`    ret *= 0.98;
warp_5=`}
```

Reassembled (after backtick strip + newline join):

```hlsl
shader_body
{
    ret = tex2D(sampler_main, uv).xyz;
    ret *= 0.98;
}
```

The compiler wraps this with a generated prelude that declares inputs, samplers, and the `ret` output. Authors only write the body inside `shader_body { ... }`. Custom `sampler` declarations and helper `#define`s go *above* `shader_body { ... }`, at the top of the assembled source (i.e. on the first few `warp_N=` / `comp_N=` lines).

### Inputs (uniforms supplied by MilkDrop)

| Group | Variables |
|---|---|
| Per-vertex (warp) | `uv` (warped UV), `uv_orig` (unwarped), `rad`, `ang` |
| Per-vertex (comp) | `uv` (unwarped), `rad`, `ang`, `hue_shader` (per-screen-position hue) |
| Time/audio | `time`, `fps`, `frame`, `progress`, `bass`, `mid`, `treb`, `vol`, `bass_att`, `mid_att`, `treb_att`, `vol_att` |
| Geometry | `aspect` (.xy = multiplier for square, .zw = inverse), `texsize` (.xy = w,h; .zw = 1/w, 1/h), `texsize_<name>` for each custom texture |
| Randomness | `rand_preset` (float4, fixed per preset load), `rand_frame` (float4, changes per frame) |
| Bridge vars | `q1`..`q32` floats, plus `_qa`..`_qh` as `float4` groupings of the same values |
| Blur clamps | `blur1_min`, `blur1_max`, `blur2_min`, `blur2_max`, `blur3_min`, `blur3_max` |
| Rotation matrices | `rot_s1..4` (static per preset), `rot_d1..4` (slow drift), `rot_f1..4`, `rot_vf1..4`, `rot_uf1..4` (increasing speeds), `rot_rand1..4` (re-randomized each frame). All `float4x3`. |
| Slow oscillators | `slow_roam_cos`, `slow_roam_sin`, `roam_cos`, `roam_sin` — float4s of slowly-varying sinusoids |

### Output

Write `ret` (float3 RGB).

### Built-in samplers

Always available, no declaration needed:

| Sampler | What |
|---|---|
| `sampler_main` | The previous frame (warp) or the warped frame (comp). |
| `sampler_fc_main`, `sampler_fw_main`, `sampler_pc_main`, `sampler_pw_main` | Same, with explicit filter/wrap (see prefix table). |
| `sampler_noise_lq` | 256×256 low-quality 2D noise. |
| `sampler_noise_lq_lite` | Smaller variant. |
| `sampler_noise_mq` | Medium-quality 2D noise. |
| `sampler_noise_hq` | High-quality 2D noise. |
| `sampler_noisevol_lq`, `sampler_noisevol_hq` | 3D (volume) noise — sample with `tex3D`. |

### Sampler prefix codes

You can request a specific filter/wrap mode for any of the above by inserting one of these between `sampler_` and the texture name:

| Prefix | Filter | Wrap |
|---|---|---|
| `fw_` | linear | repeat |
| `fc_` | linear | clamp |
| `pw_` | point | repeat |
| `pc_` | point | clamp |

So `sampler_fc_main`, `sampler_pw_noise_lq`, `sampler_fw_noisevol_hq` are all legal. With no prefix, defaults are linear+repeat for `main`/`noise`, etc.

### Custom textures

Drop a `billy.jpg` (or `.png`, `.dds`, `.tga`, `.bmp`) next to the preset (or into `milkdrop2/textures/`) and declare in the shader:

```hlsl
sampler sampler_billy;            // or sampler_fc_billy, etc.
// texsize_billy is auto-provided as float4
```

The lookup order is JPG → DDS → PNG → TGA → BMP; preset directory first, then the textures dir. A name like `sampler_rand07` picks a random texture; `sampler_rand02_smalltiled` picks from a tagged subset.

### Built-in shader helpers

`tex2D`, `tex3D` (standard HLSL), plus:

- `GetBlur1(uv)`, `GetBlur2(uv)`, `GetBlur3(uv)` — sample three progressively-blurrier downsamples of the main texture. Requires the corresponding `blur1_min`/`max` etc. config (or just rely on defaults).
- `GetMain(uv)` — convenience for `tex2D(sampler_main, uv).xyz`.
- `lum(rgb)` — luminance.

Plus standard HLSL math (`lerp`, `saturate`, `frac`, `floor`, `abs`, `min`, `max`, `sqrt`, `pow`, `exp`, `log`, `dot`, `cross`, `length`, `normalize`, `mul`, `sin`, `cos`, `atan2`, …).

### Shader performance notes

- SM2.0 caps at 64 instructions per shader. Authors hit this fast.
- `sin`, `cos`, `atan2` are ~8 instructions each; everything else (including divide) is 1–2.
- "Massive zoom-outs" trash the texture cache — sampling at very high frequency is the dominant cost.

## 9. Custom waves (`wavecode_N_*`, `wave_N_per_*`)

Up to four custom waveforms, `N` in `0..3`. Two flavors of keys:

### Static config (`wavecode_N_*`)

| Key | Range | What |
|---|---|---|
| `enabled` | 0/1 | Skip rendering this wave if 0. |
| `samples` | 0–512 | Sample count. |
| `sep` | int | Stereo separation for dual waveforms. |
| `bSpectrum` | 0/1 | 1 = sample FFT, 0 = sample raw PCM. |
| `bUseDots` | 0/1 | Render as dots. |
| `bDrawThick` | 0/1 | Thicker lines/dots. |
| `bAdditive` | 0/1 | Additive blend. |
| `scaling` | >0 | Amplitude multiplier. |
| `smoothing` | 0..1 | Temporal smoothing. |
| `r`, `g`, `b`, `a` | 0..1 | Default color. |

### Code

```
wave_N_per_frame1=…    // sets r/g/b/a/samples, reads q1..q32, t1..t8, time/audio
wave_N_per_point1=…    // for each of `samples` points; reads sample, value1, value2
```

Writable in per-point: `x`, `y` (0..1 position), `r`, `g`, `b`, `a`. Read-only: `sample` (0..1 normalized), `value1`/`value2` (PCM samples).

## 10. Custom shapes (`shapecode_N_*`, `shape_N_per_*`)

Up to four custom shapes, `N` in `0..3`. Polygons with 3–100 sides, optionally instanced and textured.

### Static config (`shapecode_N_*`)

`enabled`, `sides` (3..100), `additive`, `thickOutline`, `textured`, `num_inst` (1..1024), `x`, `y`, `rad`, `ang`, `tex_zoom`, `tex_ang`, `r`/`g`/`b`/`a` (center color), `r2`/`g2`/`b2`/`a2` (edge color), `border_r`/`g`/`b`/`a` (outline color).

### Code

```
shape_N_per_frame_init1=…   // runs once on preset load
shape_N_per_frame1=…        // runs per instance per frame; reads `instance`
```

Per-frame code can write to any of the static params plus `q`/`t` vars. There is **no** per-point code for shapes (unlike waves).

## 11. Useful conventions and gotchas

- **`per_pixel` is per-vertex, not per-pixel.** The name is historical; it runs at mesh-vertex resolution (`meshx` × `meshy`, typically 48×32). Real per-pixel work happens in the shaders.
- **A per-vertex equation that doesn't read `x`, `y`, `rad`, or `ang` should be in `per_frame`.** Otherwise it's evaluated `meshx*meshy` times for no reason.
- **Custom vars don't cross pools.** Use `q1..q32` to plumb a value from `per_frame` to `per_pixel`/shaders, `t1..t8` to plumb within a wave/shape's chain.
- **A gap in indices truncates the block.** If you delete `per_frame_5` from the middle of a 10-line block, lines 6–10 are silently dropped at load time. This is why the renumber command exists.
- **Duplicate keys: first-occurrence wins** (per the parser). Update any extension UI that says otherwise.
- **`name` lines and other freeform metadata.** Many presets carry a `name=…` line; the parser stores it but MilkDrop ignores it (the filename is canonical). Fine to leave alone.
- **Indexing usually starts at 1, not 0.** `per_frame_1`, `warp_1`, etc. But for custom waves/shapes the *outer* index (`wave_0`, `shape_0`) starts at 0 — because there are only 4 of each, indexed `0..3`. The inner code index still starts at 1.
- **No string escaping anywhere.** Values are raw to end-of-line. The HLSL bodies don't need escaping because each source line is its own key.
- **Comments inside code values** use `//` or `\\` and are stripped by the expression/shader compiler, not the file parser. So `per_frame_1=zoom = 1.0; // sit still` parses fine and the comment survives until shader-side preprocessing.

## 12. Worked examples

### Minimal v1 preset (no shaders)

```ini
[preset00]
fDecay=0.98
wave_r=1
per_frame_1=zoom = 1.0 + 0.1*sin(time);
per_frame_2=rot  = 0.03*sin(time*0.7);
```

### v2 preset with custom wave and warp shader

```ini
MILKDROP_PRESET_VERSION=201
PSVERSION=2
PSVERSION_WARP=2
PSVERSION_COMP=2
[preset00]
fDecay=0.98
wave_a=0

wavecode_0_enabled=1
wavecode_0_samples=512
wavecode_0_bDrawThick=1
wavecode_0_r=1.000
wavecode_0_g=0.500
wavecode_0_b=0.000
wavecode_0_a=1.000
wave_0_per_point1=x = sample;
wave_0_per_point2=y = 0.5 + value1*0.4;

per_frame_1=q1 = 0.5 + 0.5*sin(time);

warp_1=`shader_body
warp_2=`{
warp_3=`    float2 warped = uv + 0.01*sin(uv.yx*10.0 + time);
warp_4=`    ret = tex2D(sampler_main, warped).xyz;
warp_5=`    ret *= 0.97;
warp_6=`}

comp_1=`shader_body
comp_2=`{
comp_3=`    ret = tex2D(sampler_main, uv).xyz;
comp_4=`    ret *= 1.8;
comp_5=`}
```

### Per-vertex + bridge variable

```ini
per_frame_1=q1 = bass;
per_frame_2=q2 = treb;
per_pixel_1=zoom = zoom + (rad - 0.5) * q1 * 0.1;
per_pixel_2=rot  = rot  + (1.0 - rad) * q2 * 0.02;
```

`q1`/`q2` are computed once per frame and read at each vertex; `zoom`/`rot` start from their per-frame values and get per-vertex overrides.

### Custom 3D-noise warp (from a real preset)

```ini
warp_1=`sampler sampler_fw_noisevol_hq;
warp_2=`shader_body
warp_3=`{
warp_4=`    float3 pos = float3(uv.x, uv.y, q1);
warp_5=`    float3 rc  = tex3D(sampler_fw_noisevol_hq, pos);
warp_6=`    rc += tex3D(sampler_fw_noisevol_hq, 2*pos) * 0.5;
warp_7=`    rc += tex3D(sampler_fw_noisevol_hq, 4*pos) * 0.25;
warp_8=`    rc  = (rc*rc*rc) - GetBlur1(uv);
warp_9=`    ret = tex2D(sampler_fc_main, uv).xyz + 0.05 * rc * q3;
warp_10=`}
```

Note the custom `sampler` declaration on `warp_1=` lives *above* `shader_body { ... }` in the reassembled source.

---

## 13. Current extension snapshot

| File | What it does |
|---|---|
| [package.json](package.json) | Manifest. Registers `milkdrop` language for `.milk`, the TextMate grammar, the renumber command + keybinding. |
| [language-configuration.json](language-configuration.json) | Line comment `//`, bracket pairs. |
| [syntaxes/milkdrop.tmLanguage.json](syntaxes/milkdrop.tmLanguage.json) | TextMate grammar. Covers `[section]`, `//` comments, `warp_N=\`…` / `comp_N=\`…` shader lines (begin HLSL embed), code lines, generic `key=value`, and an `expression-keyword` list. |
| [src/extension.ts](src/extension.ts) | Activation code. `INDEXED_PREFIXES = ['comp','warp','per_frame','per_pixel','per_frame_init']`. Provides: renumber command, duplicate-key diagnostic, line-start completion of next index, and (via `src/hlsl.ts`) HLSL shader syntax diagnostics. |
| [src/hlsl.ts](src/hlsl.ts) | HLSL syntax validation for `warp_`/`comp_` blocks. Loads `wasm/tree-sitter-hlsl.wasm` via `web-tree-sitter` (lazy, async, fails soft). Reassembles each block, normalizes the `shader_body`/`sampler_state` quirks, parses, emits one `Error` diagnostic per block at the first `ERROR`/`MISSING` node. Gated by `milkdrop.shaderDiagnostics.enable`. tree-sitter does syntax only — no name resolution, so undeclared MilkDrop uniforms/samplers are *not* flagged (by design; that's why the prelude isn't needed). |
| [wasm/tree-sitter-hlsl.wasm](wasm/) | Prebuilt grammar, committed. Rebuild with `npm run build:wasm` (needs the `tree-sitter` CLI; downloads the WASI SDK on first run). |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) / [LICENSE](LICENSE) | MIT notices for tree-sitter / tree-sitter-hlsl; extension itself is MIT (© Matthew Bellew). |
| [TODO.md](TODO.md) | Roadmap (v0.2 QoL, v0.3 HLSL injection, v0.4 live preview, v1.0 marketplace). |

### Known correctness issues

Resolved:

1. ~~**Duplicate-key behavior**~~ — fixed. The diagnostic now reports first-wins ("projectM keeps the first occurrence; this line is dropped at load time"), via `duplicateDiagnostics` in [src/extension.ts](src/extension.ts).
2. ~~**Pattern B prefixes missing**~~ — fixed. `PATTERN_B_RE` covers `wave_<N>_per_frame|per_point` and `shape_<N>_per_frame|per_frame_init`; both patterns are case-insensitive (keys are case-insensitive at load time, casing preserved on output).
3. ~~**Gap-truncation diagnostic**~~ — done. `gapDiagnostics` flags every line past the first missing index ("dropped at load time… renumber to close the gap"), for all prefixes. The shader validator ([src/hlsl.ts](src/hlsl.ts)) skips a gap-truncated block so it doesn't emit a misleading whole-block parse error — the gap diagnostic owns that case.

Outstanding:

4. **First-line key-only parsing**: the parser also accepts `key value` (space delimiter). Real presets rarely do this, but the grammar's `kv-line` regex insists on `=`. Low priority — flag if seen.

### Conventions the extension should preserve

- Keys are case-insensitive at load time but conventionally written in their original mixed-case form (e.g. `MILKDROP_PRESET_VERSION`, `fDecay`, `nWaveMode`). Don't autocorrect casing.
- Indented lines are technically broken (parser drops them). But blank lines anywhere are fine, including between blocks.
- The `[preset00]` header is decorative. Don't bless or require it.

---

## 14. When extending the extension

A few things to keep in mind:

- **Verify against the parser, not the docs.** The geisswerks guide is canonical for authoring intent, but projectM's `PresetFileParser.cpp` is what actually runs. When they conflict, the parser wins (and that's what users will hit).
- **Test against `../projectm/cmake-build/presets/`** — that tree has ~9,800 real-world presets. Good fodder for regex coverage checks.
- **The HLSL embed scope is `meta.embedded.block.hlsl.milkdrop`** in the TextMate grammar. VS Code only does anything with that if the user has an HLSL grammar installed. Shipping a minimal HLSL grammar is on the v0.3 roadmap.
- **No formal grammar exists** for the expression language or the HLSL prelude. Anything fancier than the current keyword-list approach (hover docs, signature help, semantic completion) means writing one.
- **The renumber command must skip the value side of `=`.** A line like `per_frame_3=q3 = sin(time);` has more `=` signs than the key — only the line-prefix one matters. The current regex is anchored to BOL so it's fine, but keep it that way.
