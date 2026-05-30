---
applyTo: "**/*.milk"
description: How to correctly read, edit, and fix MilkDrop .milk preset files.
---

# Editing `.milk` MilkDrop presets

A `.milk` file is a flat, case-insensitive list of `key=value` lines consumed by
MilkDrop / projectM. It has no nesting, no escaping, and **no variable
declarations** — which means most mistakes are *silent*. Follow these rules so
your edits actually load and behave the way you intend. The ground truth is
projectM's `PresetFileParser.cpp` and the `projectm-eval` compiler, not the
authoring guides.

If the Milkdrop language extension is installed, **check the Problems panel
after editing** — it flags every problem described below (duplicate keys, index
gaps, expression/HLSL syntax, and variables read but never assigned).

## The parser, in five rules

1. **`key=value`, delimiter is the first `=` *or* space.** `name=My Preset` and
   `name My Preset` both parse (value = `My Preset`). A key can't contain a space.
2. **Keys are case-insensitive.** `fDecay` and `fdecay` are the same key. Casing
   in the file is decorative — **preserve the original mixed-case spelling**
   (`MILKDROP_PRESET_VERSION`, `fDecay`, `nWaveMode`); don't "correct" it.
3. **First occurrence wins for duplicate keys.** A second `per_frame_3=…` is
   silently dropped at load. Never duplicate a key to "override" an earlier one.
4. **Lines with no `=`/space, or starting with `=`/space, are skipped.** That's
   why `[preset00]` and blank lines are harmless. **Never indent a key line** —
   an indented `  per_frame_1=…` is silently dropped. Blank lines anywhere are fine.
5. Unknown keys are ignored. **A misspelled config key is silently inert** — no
   error, no effect. Use exact names.

## Indexed code blocks — the most common mistake

Long code (per-frame equations, custom waves/shapes, shaders) is split across
numbered keys that the loader reassembles by appending `1, 2, 3, …` to a prefix
**and stopping at the first missing index.**

- **A gap truncates the block.** If you delete `per_frame_5` from a 10-line
  block, lines 6–10 are silently dropped at load. Whenever you **delete, insert,
  or reorder** a line in a block, **renumber the block** so the indices stay
  contiguous — see "How to renumber a block" below.
- Indexing starts at **1**, not 0 (except the *outer* wave/shape index, which is
  `0..3`).
- There are **two key-naming patterns** — get them right:

  | Pattern | Shape | Examples |
  |---|---|---|
  | **A** — underscore before index | `<prefix>_<N>=` | `per_frame_1=`, `per_frame_init_1=`, `per_pixel_1=`, `warp_1=`, `comp_1=` |
  | **B** — NO underscore before *inner* index | `<thing>_<outer>_<part><N>=` | `wave_0_init1=`, `wave_0_per_frame1=`, `wave_0_per_point1=`, `shape_0_init1=`, `shape_0_per_frame1=` |

  In pattern B the outer number (`0..3`) is the wave/shape index; the inner
  number (no underscore) is the code-line index. The init stage is keyed **`init`**
  — `wave_0_init1=`, `shape_0_init1=` — **not** `per_frame_init`. `wavecode_0_*` /
  `shapecode_0_*` are plain static config, **not** indexed code — leave them alone
  when renumbering.

### How to renumber a block

Rewrite the numeric suffixes of the keys in one block so they run `1, 2, 3, …`
with **no gaps and no duplicates**, in top-to-bottom order. Change only the number
in the key — never touch the value after `=`. Renumber each block (each distinct
prefix) independently.

For pattern A, the index is the trailing number after the last `_`. Example —
after deleting a line, a gap was left at index 3:

```ini
# Before — index 3 is missing, so per_frame_4 is DROPPED at load:
per_frame_1=q1 = bass;
per_frame_2=q2 = treb;
per_frame_4=q3 = q1 + q2;

# After — renumbered to close the gap:
per_frame_1=q1 = bass;
per_frame_2=q2 = treb;
per_frame_3=q3 = q1 + q2;
```

For pattern B, change only the **inner** (code-line) number; the outer wave/shape
index is fixed: `wave_0_per_point1=`, `wave_0_per_point2=`, `wave_0_per_point3=`, …

Renumber by editing the keys directly. (A human author can instead run the
command **“Milkdrop: Renumber Indexed Blocks”** / `Ctrl/Cmd+Alt+R`, which
renumbers every block in the file at once — but an AI agent should not assume it
can invoke that command, and should just edit the key numbers.)

## No declarations → typos read as 0 (silent)

Any bare name in expression code auto-declares to `0`. So:

- A **misspelled variable** (`bas` for `bass`, `trev` for `treb`) does not error —
  it just silently reads `0`. The extension flags a name that is *read but never
  assigned in its pool* as a warning; treat those as real bugs to fix.
- **Variable pools are separate.** User variables do **not** cross between stages.
  The only carriers are:
  - **`q1`..`q32`** — set in `per_frame`, readable in `per_pixel`, custom
    wave/shape code, and shaders. Use these to pass per-frame values downstream.
  - **`t1`..`t8`** — carry within a single custom wave/shape's stages (init →
    per-frame → per-point).
  - **`reg00`..`reg99`** and `gmegabuf` — global across everything.
  - Which stages **share** a pool (one eval context) vs. are **separate**:
    - `per_frame_init` + `per_frame` share one pool (init seeds the per-frame
      variables); `per_pixel` is its own pool.
    - Each custom wave: its `init` + `per_frame` share one pool; its `per_point`
      is a **separate** pool — only `q`, `t`, and the wave's `r`/`g`/`b`/`a` carry
      into per-point.
    - Each custom shape: its `init` + `per_frame` share one pool.
  - So: do not expect a normal variable set in `per_frame` to show up in
    `per_pixel` (or set in a wave's `per_frame` to show up in its `per_point`).
    Route it through a `q` variable (or, within one wave/shape, a `t` variable).

## Expression language (per-frame / per-pixel / wave / shape)

A small expression language. Statements are separated by `;`. There is no
control flow — `if(cond, a, b)` is a function that **evaluates both `a` and `b`**,
then returns one. Prefer `above(a,b)`/`below(a,b)`/`equal(a,b)` (which return 0 or
1) over bare comparison operators.

- Functions and their required number of arguments: `sin/cos/tan/asin/acos/atan`
  (1), `atan2` (2), `sqrt/sqr/exp/log/log10/abs/sign/floor/ceil/int/rand` (1,
  `int` truncates toward zero), `pow/min/max/sigmoid/band/bor` (2), `if` (3),
  `bnot` (1). Calling a function with the wrong number of arguments, calling an
  unknown name as a function, or naming a function without `()` are all compile
  errors.
- `gmem` must be **indexed**: `gmem[i]`, never called.
- Lines in a block are joined with a bare newline (no `;` inserted). So a line that
  is a **complete statement with no trailing `;`**, followed by another statement,
  is an error; but a line ending mid-expression (e.g. trailing `*`) legally
  continues onto the next line. When in doubt, end each line's statement with `;`.
- **`per_pixel` is per-vertex** (mesh ~48×32), evaluated thousands of times per
  frame. If an equation doesn't read `x`, `y`, `rad`, or `ang`, move it to
  `per_frame` (one eval/frame) instead.

### Config-key vs expression-variable names differ

The same setting has a **file-scalar** name and a (usually shorter) **expression**
name. Set the initial value with the scalar key; animate it in `per_frame` with
the expression variable:

| Setting | Scalar config key (file) | Expression variable (per-frame) |
|---|---|---|
| decay | `fDecay=0.98` | `decay = decay*0.99;` |
| wave mode | `nWaveMode=2` | `wave_mode = 3;` |
| gamma | `fGammaAdj=2` | `gamma = 1 + bass;` |
| invert | `bInvert=0` | `invert = 1;` |
| zoom/rot/warp/cx/cy/dx/dy/sx/sy | `zoom=1`, `rot=0`, … | same short names |
| wave color | `wave_r/g/b/a=…` | `wave_r = 0.5 + 0.5*sin(time);` |

Writing the scalar (`fDecay`) name *inside* per-frame code, or the expression
(`decay`) name as a top-level config line, silently does nothing.

## Shaders (`warp_` / `comp_`, presets v2+: `MILKDROP_PRESET_VERSION>=200`)

 - Each HLSL source line is one key whose value begins with a backtick. For example:

 ```ini
 warp_1=`shader_body
 ```

 The loader strips exactly one leading backtick per line, then joins the lines with a newline. **Keep the backtick** on every shader line you add.
- Author code goes inside `shader_body { … }`. Custom `sampler …;` declarations
  and `#define`s go **above** `shader_body`, on the first `warp_`/`comp_` lines.
- Output is `ret` (float3 RGB). Built-in samplers (`sampler_main`, `sampler_noise_*`,
  …) and uniforms (`time`, `bass`, `q1..q32`, `texsize`, `uv`, `rad`, …) are
  provided — don't redeclare them.
- Text after the `}` that closes `shader_body` is ignored by the engine — but
  don't rely on it; keep notes in `//` comments.

## Editing checklist

- Adding a code line → use the next **contiguous** index; if inserting in the
  middle, **renumber** the whole block afterward.
- Deleting a code line → **renumber** to close the gap (or the tail is dropped).
- Need a per-frame value in `per_pixel`/shaders → route it through a `q` variable.
- Preserve key casing; never indent key lines; don't duplicate keys.
- After editing, **read the Problems panel** and resolve the Milkdrop diagnostics
  (duplicate key, index gap, expression/HLSL syntax, read-never-assigned).
