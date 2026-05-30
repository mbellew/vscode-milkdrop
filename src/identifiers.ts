// The complete set of built-in (engine-registered) variable names for each
// expression-code pool, plus helpers to classify an identifier as built-in.
//
// Ground truth: projectM registers a fixed list of variables into each
// projectm-eval context via `RegisterBuiltinVariables()` (the `REG_VAR(...)`
// macro). These names are transcribed verbatim from:
//
//   src/libprojectM/MilkdropPreset/PerFrameContext.cpp
//   src/libprojectM/MilkdropPreset/PerPixelContext.cpp
//   src/libprojectM/MilkdropPreset/WaveformPerFrameContext.cpp
//   src/libprojectM/MilkdropPreset/WaveformPerPointContext.cpp
//   src/libprojectM/MilkdropPreset/ShapePerFrameContext.cpp
//
// On top of the per-context list, every pool also registers q1..q32 (QVarCount),
// and the custom-wave/shape pools additionally register t1..t8 (TVarCount).
// `reg00`..`reg99` are global registers (projectm-eval/TreeVariables.c) shared
// across every context, so they are built-in everywhere. Variable lookups are
// case-insensitive (projectm-eval uses strcasecmp), so all names here are
// lowercase and callers must lowercase before testing membership.

export type PoolKind =
    | 'per_frame'      // per_frame_init + per_frame (one shared context)
    | 'per_pixel'
    | 'wave_per_frame'
    | 'wave_per_point'
    | 'shape_per_frame';

function words(s: string): string[] {
    return s.trim().split(/\s+/);
}

// q1..q32 (every pool) and t1..t8 (custom wave/shape pools only).
const Q_VARS = Array.from({ length: 32 }, (_, i) => `q${i + 1}`);
const T_VARS = Array.from({ length: 8 }, (_, i) => `t${i + 1}`);

// PerFrameContext.cpp — REG_VAR list. Many are writable render params loaded
// with the current state each frame (zoom, rot, wave_r, decay, gamma, …), so
// reading them without an assignment is legal.
const PER_FRAME = words(`
    zoom zoomexp rot warp cx cy dx dy sx sy time fps bass mid treb
    bass_att mid_att treb_att frame decay wave_a wave_r wave_g wave_b
    wave_x wave_y wave_mystery wave_mode progress ob_size ob_r ob_g ob_b ob_a
    ib_size ib_r ib_g ib_b ib_a mv_x mv_y mv_dx mv_dy mv_l mv_r mv_g mv_b mv_a
    echo_zoom echo_alpha echo_orient wave_usedots wave_thick wave_additive
    wave_brighten darken_center gamma wrap invert brighten darken solarize
    meshx meshy pixelsx pixelsy aspectx aspecty
    blur1_min blur2_min blur3_min blur1_max blur2_max blur3_max blur1_edge_darken
    video_alpha_mode video_alpha_value video_alpha_init video_alpha_decay video_cleanup
`);

// PerPixelContext.cpp — adds the per-vertex coordinates x/y/rad/ang.
const PER_PIXEL = words(`
    zoom zoomexp rot warp cx cy dx dy sx sy time fps bass mid treb
    bass_att mid_att treb_att frame x y rad ang progress
    meshx meshy pixelsx pixelsy aspectx aspecty
`);

// WaveformPerFrameContext.cpp
const WAVE_PER_FRAME = words(`
    time fps frame progress bass mid treb bass_att mid_att treb_att
    r g b a samples
`);

// WaveformPerPointContext.cpp — adds sample/value1/value2 and x/y.
const WAVE_PER_POINT = words(`
    time fps frame progress bass mid treb bass_att mid_att treb_att
    sample value1 value2 x y r g b a
`);

// ShapePerFrameContext.cpp
const SHAPE_PER_FRAME = words(`
    time fps frame progress bass mid treb bass_att mid_att treb_att
    x y rad ang tex_ang tex_zoom sides textured instance num_inst additive thick
    r g b a r2 g2 b2 a2 border_r border_g border_b border_a
`);

function poolSet(base: string[], withT: boolean): ReadonlySet<string> {
    return new Set([...base, ...Q_VARS, ...(withT ? T_VARS : [])]);
}

const BUILTINS: Record<PoolKind, ReadonlySet<string>> = {
    per_frame: poolSet(PER_FRAME, false),
    per_pixel: poolSet(PER_PIXEL, false),
    wave_per_frame: poolSet(WAVE_PER_FRAME, true),
    wave_per_point: poolSet(WAVE_PER_POINT, true),
    shape_per_frame: poolSet(SHAPE_PER_FRAME, true),
};

// `reg00`..`reg99`: exactly "reg" + two digits (projectm-eval/TreeVariables.c).
const REG_RE = /^reg\d\d$/;

// Map a block grouping prefix (IndexedCodeLine.prefix, lowercased) to its pool.
// Returns null for shader prefixes (comp/warp) and anything unrecognized.
export function poolForPrefix(prefix: string): PoolKind | null {
    const p = prefix.toLowerCase();
    if (p === 'per_frame_init' || p === 'per_frame') {
        return 'per_frame';
    }
    if (p === 'per_pixel') {
        return 'per_pixel';
    }
    // A custom wave's init code shares the per-frame eval context (CustomWaveform.cpp),
    // so `wave_<N>_init` and `wave_<N>_per_frame` are the same pool kind.
    if (/^wave_\d+_init$/.test(p) || /^wave_\d+_per_frame$/.test(p)) {
        return 'wave_per_frame';
    }
    if (/^wave_\d+_per_point$/.test(p)) {
        return 'wave_per_point';
    }
    // Likewise a custom shape's init shares its per-frame context (CustomShape.cpp).
    if (/^shape_\d+_init$/.test(p) || /^shape_\d+_per_frame$/.test(p)) {
        return 'shape_per_frame';
    }
    return null;
}

// Is `name` an engine-provided built-in in the given pool? `name` should already
// be lowercased by the caller (variable lookups are case-insensitive).
export function isBuiltinVar(nameLower: string, pool: PoolKind): boolean {
    return BUILTINS[pool].has(nameLower) || REG_RE.test(nameLower);
}

// ── Scalar config keys ──────────────────────────────────────────────────────
// The engine-recognized `key=value` config keys, transcribed from the literal
// names projectM reads via GetFloat/GetInt/GetBool/GetString across the
// MilkdropPreset/*.cpp components. Unlike the expression variables above, these
// use the file's Hungarian spellings (fDecay, nWaveMode, bInvert) and include
// the version headers. Keys are case-insensitive at load time (GetX lowercases),
// so all names here are lowercase and callers must lowercase before testing.
// An UNKNOWN config key is silently ignored by MilkDrop, so completeness matters:
// a name not in this set should be treated as a likely typo.
const SCALAR_CONFIG_KEYS: ReadonlySet<string> = new Set(words(`
    milkdrop_preset_version psversion psversion_warp psversion_comp
    fdecay fgammaadj fvideoechozoom fvideoechoalpha nvideoechoorientation
    fshader fwarpanimspeed fwarpscale fzoomexponent
    bbrighten bdarken bsolarize binvert bdarkencenter btexwrap bredbluestereo
    zoom rot warp cx cy dx dy sx sy
    nwavemode wave_r wave_g wave_b wave_x wave_y fwaveparam
    fwavealpha fwavescale fwavesmoothing badditivewaves bwavedots bwavethick
    bmaximizewavecolor bmodwavealphabyvolume fmodwavealphastart fmodwavealphaend
    ob_size ob_r ob_g ob_b ob_a ib_size ib_r ib_g ib_b ib_a
    bmotionvectorson nmotionvectorsx nmotionvectorsy mv_dx mv_dy mv_l mv_r mv_g mv_b mv_a
    b1n b1x b1ed b2n b2x b3n b3x
`));

// Static config params for custom waves (wavecode_N_<param>) and custom shapes
// (shapecode_N_<param>), from CustomWaveform.cpp / CustomShape.cpp.
const WAVECODE_PARAMS: ReadonlySet<string> = new Set(words(`
    enabled samples sep bspectrum busedots bdrawthick badditive scaling smoothing r g b a
`));
const SHAPECODE_PARAMS: ReadonlySet<string> = new Set(words(`
    enabled sides additive thickoutline textured num_inst x y rad ang tex_ang tex_zoom
    r g b a r2 g2 b2 a2 border_r border_g border_b border_a image
`));

// Is `nameLower` an engine-recognized scalar config key / wave / shape param?
export function isScalarConfigKey(nameLower: string): boolean {
    return SCALAR_CONFIG_KEYS.has(nameLower);
}
export function isWavecodeParam(nameLower: string): boolean {
    return WAVECODE_PARAMS.has(nameLower);
}
export function isShapecodeParam(nameLower: string): boolean {
    return SHAPECODE_PARAMS.has(nameLower);
}
