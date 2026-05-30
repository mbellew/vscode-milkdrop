import * as vscode from 'vscode';
import { tokenize, reassembleGroup, IndexedCodeLine } from './expr';
import {
    poolForPrefix,
    isBuiltinVar,
    isScalarConfigKey,
    isWavecodeParam,
    isShapecodeParam,
} from './identifiers';
import { IndexedLine, scanIndexedLines } from './indexed';

// Semantic highlighting for the expression-code blocks (per_frame, per_pixel,
// custom wave/shape code). The `.milk` expression language auto-declares every
// bare name, so a misspelled built-in (e.g. `bas` for `bass`) silently reads as
// zero with no error. We can't flag it as wrong, but we CAN make every *known*
// built-in stand out: built-in variables and functions get the standard
// `variable.defaultLibrary` / `function.defaultLibrary` token (themes colour
// these distinctly), so a typo loses that colouring and is easy to spot.
//
// Only built-ins are emitted — user-defined names fall through to the default
// foreground, so nothing the author wrote is recoloured or flagged.

// Standard token types/modifiers so existing themes style them without extra
// configuration (Dark+/Light+ and most others map `*.defaultLibrary`).
const TOKEN_TYPES = ['variable', 'function'];
const TOKEN_MODIFIERS = ['defaultLibrary'];
export const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

const VARIABLE = TOKEN_TYPES.indexOf('variable');
const FUNCTION = TOKEN_TYPES.indexOf('function');
const DEFAULT_LIBRARY = 1 << TOKEN_MODIFIERS.indexOf('defaultLibrary');

// Second-pass config lines. The key (or the param after the wavecode_N_/
// shapecode_N_ prefix) is the engine-recognized name we highlight — consistent
// with how the same names are coloured when written in expression code.
const WAVECODE_LINE_RE = /^(wavecode_\d+_)([A-Za-z_][A-Za-z0-9_]*)\s*=/i;
const SHAPECODE_LINE_RE = /^(shapecode_\d+_)([A-Za-z_][A-Za-z0-9_]*)\s*=/i;
const SCALAR_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/;

interface Emit {
    line: number;
    char: number;
    length: number;
    type: number;
    modifiers: number;
}

function groupByPrefix(indexed: ReadonlyArray<IndexedLine>): Map<string, IndexedLine[]> {
    const groups = new Map<string, IndexedLine[]>();
    for (const l of indexed) {
        const key = `${l.prefix}${l.separator}`.toLowerCase();
        const g = groups.get(key);
        if (g) {
            g.push(l);
        } else {
            groups.set(key, [l]);
        }
    }
    return groups;
}

export class MilkdropSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
        const emits: Emit[] = [];
        const groups = groupByPrefix(scanIndexedLines(document));

        for (const lines of groups.values()) {
            const pool = poolForPrefix(lines[0].prefix);
            if (pool === null) {
                continue; // shader (comp/warp) or unrecognized prefix — not expression code
            }
            // Reassemble exactly like the engine so multi-line comments and the
            // backtick/key column offsets line up with the document.
            const asm = reassembleGroup(lines as IndexedCodeLine[]);
            for (const tok of tokenize(asm.source)) {
                if (tok.line >= asm.rows.length) {
                    continue;
                }
                let type: number;
                let modifiers = DEFAULT_LIBRARY;
                if (tok.type === 'func' || tok.type === 'gmem') {
                    type = tok.type === 'gmem' ? VARIABLE : FUNCTION;
                } else if (tok.type === 'name' && isBuiltinVar(tok.value.toLowerCase(), pool)) {
                    type = VARIABLE;
                } else {
                    continue; // user-defined name, number, operator — leave default
                }
                const row = asm.rows[tok.line];
                emits.push({
                    line: row.docLine,
                    char: row.colOffset + tok.col,
                    length: tok.endCol - tok.col,
                    type,
                    modifiers,
                });
            }
        }

        // Second pass: scalar config keys and wavecode_/shapecode_ params. These
        // aren't indexed expression code, so they're scanned line-by-line here.
        // A known key is highlighted like a built-in variable; an unknown one is
        // left plain (and, since MilkDrop silently ignores unknown keys, that
        // plainness is itself a typo cue).
        for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
            const text = document.lineAt(lineNum).text;
            const wave = WAVECODE_LINE_RE.exec(text);
            if (wave) {
                if (isWavecodeParam(wave[2].toLowerCase())) {
                    emits.push({ line: lineNum, char: wave[1].length, length: wave[2].length, type: VARIABLE, modifiers: DEFAULT_LIBRARY });
                }
                continue;
            }
            const shape = SHAPECODE_LINE_RE.exec(text);
            if (shape) {
                if (isShapecodeParam(shape[2].toLowerCase())) {
                    emits.push({ line: lineNum, char: shape[1].length, length: shape[2].length, type: VARIABLE, modifiers: DEFAULT_LIBRARY });
                }
                continue;
            }
            const scalar = SCALAR_LINE_RE.exec(text);
            if (scalar && isScalarConfigKey(scalar[1].toLowerCase())) {
                emits.push({ line: lineNum, char: 0, length: scalar[1].length, type: VARIABLE, modifiers: DEFAULT_LIBRARY });
            }
        }

        // SemanticTokensBuilder requires tokens in ascending (line, char) order.
        emits.sort((a, b) => (a.line - b.line) || (a.char - b.char));
        const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
        for (const e of emits) {
            builder.push(e.line, e.char, e.length, e.type, e.modifiers);
        }
        return builder.build();
    }
}
