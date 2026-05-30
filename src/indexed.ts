import * as vscode from 'vscode';

// Two on-disk shapes for indexed code keys (see CLAUDE.md §4).
//
// Pattern A — underscore between suffix and index:
//   per_frame_1=, per_frame_init_1=, per_pixel_1=, warp_1=`..., comp_1=`...
// Case-insensitive: MilkDrop lowercases keys at load time, so `Comp_1=` and
// `COMP_1=` are valid. The capture group preserves the file's original casing,
// which we echo back when renumbering (don't autocorrect casing).
const PATTERN_A_RE = /^(per_frame_init|per_frame|per_pixel|warp|comp)_(\d+)(=.*)$/i;

// Pattern B — custom wave/shape code, NO underscore between suffix and inner index:
//   wave_0_init1=, wave_0_per_frame1=, wave_0_per_point1=, shape_2_init1=, ...
// The outer N (wave/shape index, typically 0..3) is part of the grouping prefix
// so wave_0_per_point and wave_1_per_point renumber independently.
//
// The init stage is keyed `<wave|shape>_<N>_init<M>` — NOT `per_frame_init`.
// projectM reassembles it via GetCode("wave_<N>_init") / GetCode("shape_<N>_init")
// (PresetState.cpp:145,154); the corpus confirms `wave_0_init…`/`shape_0_init…`
// are the only forms used (zero occurrences of `*_per_frame_init`).
const PATTERN_B_RE = /^((?:wave|shape)_\d+_(?:init|per_frame|per_point))(\d+)(=.*)$/i;

export interface IndexedLine {
    lineNumber: number;
    prefix: string;    // grouping key, e.g. 'per_frame' or 'wave_0_per_point'
    separator: string; // '_' for Pattern A, '' for Pattern B
    index: number;     // trailing numeric index ordering lines within a block
    rest: string;      // includes leading '='
}

export function matchIndexedLine(text: string): Omit<IndexedLine, 'lineNumber'> | null {
    const a = text.match(PATTERN_A_RE);
    if (a) {
        return { prefix: a[1], separator: '_', index: parseInt(a[2], 10), rest: a[3] };
    }
    const b = text.match(PATTERN_B_RE);
    if (b) {
        return { prefix: b[1], separator: '', index: parseInt(b[2], 10), rest: b[3] };
    }
    return null;
}

export function scanIndexedLines(doc: vscode.TextDocument): IndexedLine[] {
    const out: IndexedLine[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
        const parsed = matchIndexedLine(doc.lineAt(i).text);
        if (parsed) {
            out.push({ lineNumber: i, ...parsed });
        }
    }
    return out;
}
