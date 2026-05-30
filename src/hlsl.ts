import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { Parser, Language, Node } from 'web-tree-sitter';

// Syntax validation for the embedded HLSL warp/comp shaders, backed by the
// tree-sitter-hlsl grammar compiled to WASM (see wasm/tree-sitter-hlsl.wasm).
//
// tree-sitter only does *syntax*, not name resolution, so undeclared MilkDrop
// uniforms/samplers (uv, q1, sampler_main, …) are not errors — we don't need
// the generated prelude. We only catch structural mistakes: missing ';' / '}',
// stray tokens, etc.

let parser: Parser | null = null;
let initPromise: Promise<boolean> | null = null;

// Initialise the WASM parser once. Returns false (and stays false) if anything
// goes wrong, so shader diagnostics silently degrade to a no-op rather than
// breaking the rest of the extension.
export function initHlsl(extensionPath: string): Promise<boolean> {
    if (initPromise) {
        return initPromise;
    }
    initPromise = (async () => {
        try {
            const glueDir = path.dirname(require.resolve('web-tree-sitter'));
            await Parser.init({ locateFile: (f: string) => path.join(glueDir, f) });
            const grammarPath = path.join(extensionPath, 'wasm', 'tree-sitter-hlsl.wasm');
            const lang = await Language.load(fs.readFileSync(grammarPath));
            parser = new Parser();
            parser.setLanguage(lang);
            return true;
        } catch (err) {
            console.error('milkdrop: failed to initialise HLSL parser', err);
            parser = null;
            return false;
        }
    })();
    return initPromise;
}

export function isHlslReady(): boolean {
    return parser !== null;
}

const SHADER_PREFIXES = ['warp', 'comp'];

// One assembled shader source plus a per-row map back into the document.
interface Assembled {
    source: string;
    // rows[r] describes assembled-source row r (0-based).
    rows: { docLine: number; colOffset: number }[];
    // True when the block has a gap (e.g. a duplicate index leaves `_5` absent):
    // projectM stops at the first missing index, so higher-indexed lines never
    // load and the assembled source is a truncated fragment. Syntax-validating
    // it is meaningless — the gap-truncation diagnostic owns that case.
    truncated: boolean;
}

// Reassemble a shader block exactly like projectM's GetCode(): gather
// `<prefix>_1`, `_2`, … in order, stop at the first gap, strip one leading
// backtick per line. Returns null if the block is absent.
function reassemble(doc: vscode.TextDocument, prefix: string): Assembled | null {
    const keyRe = new RegExp(`^${prefix}_(\\d+)=`, 'i');
    const byIndex = new Map<number, { docLine: number; value: string; valueStart: number }>();

    for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text;
        const m = keyRe.exec(text);
        if (!m) {
            continue;
        }
        const idx = parseInt(m[1], 10);
        const valueStart = m[0].length; // char index just past the '='
        // First occurrence wins (matches the parser); ignore later duplicates.
        if (!byIndex.has(idx)) {
            byIndex.set(idx, { docLine: i, value: text.slice(valueStart), valueStart });
        }
    }

    if (!byIndex.has(1)) {
        return null;
    }

    const sources: string[] = [];
    const rows: { docLine: number; colOffset: number }[] = [];
    for (let i = 1; byIndex.has(i); i++) {
        const entry = byIndex.get(i)!;
        let value = entry.value;
        let colOffset = entry.valueStart;
        if (value.startsWith('`')) {
            value = value.slice(1);
            colOffset += 1;
        }
        sources.push(value);
        rows.push({ docLine: entry.docLine, colOffset });
    }

    // If more distinct indices exist than we loaded contiguously, there's a gap
    // and the higher-indexed lines are dropped at load time.
    const truncated = byIndex.size > sources.length;

    return { source: sources.join('\n'), rows, truncated };
}

// Replace a matched span with spaces, preserving newlines so row/column
// positions downstream are unaffected.
function blankPreservingNewlines(s: string): string {
    return s.replace(/[^\n]/g, ' ');
}

// Discard everything after the brace that closes `shader_body`, mirroring
// projectM's MilkdropShader::PreprocessPresetShader (which resizes the program
// at the matching close brace). Real presets routinely leave trailing notes
// ("written by martin", "END", stray code) after the final `}`; the parser
// would otherwise treat that tail as part of the source and emit a spurious
// whole-block error. We blank the tail rather than slice it so the row/column
// mapping built in reassemble() stays valid. Brace matching skips `//` and
// `/* */` comments, matching projectM's scanner.
function truncateAfterBody(source: string): string {
    const m = /\bshader_body\b/.exec(source);
    if (!m) {
        return source;
    }
    let i = source.indexOf('{', m.index);
    if (i < 0) {
        return source;
    }
    let depth = 1;
    for (i++; i < source.length && depth > 0; i++) {
        const c = source[i];
        if (c === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') {
                i++;
            }
            continue; // for-loop's i++ steps past the newline
        }
        if (c === '/' && source[i + 1] === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
                i++;
            }
            i++; // land on the '/'; for-loop's i++ steps past it
            continue;
        }
        if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
        }
    }
    if (depth !== 0) {
        return source; // unbalanced — let the parser report the real error
    }
    // i now sits just past the matching '}'.
    return source.slice(0, i) + blankPreservingNewlines(source.slice(i));
}

// Make the assembled body parseable by the C-based HLSL grammar without
// shifting any row (column drift is confined to the `shader_body` line, which
// carries no other tokens in practice):
//   - trailing text after the body's closing `}`  ->  blanked (projectM drops it).
//   - `shader_body { … }`  ->  a real function definition.
//   - `= sampler_state { … }`  ->  blanked out (legacy D3D9 effect-framework
//     syntax the grammar doesn't model; would otherwise yield false positives).
function normalize(source: string): string {
    let s = truncateAfterBody(source);
    s = s.replace(/\bshader_body\b/, 'float4 shader_body() : COLOR');
    s = s.replace(/=\s*sampler_state\s*\{[^}]*\}/gi, blankPreservingNewlines);
    return s;
}

// Collect the innermost ERROR / MISSING nodes (skip an error node when a
// descendant is also an error, so we report the precise spot, not the whole
// enclosing block).
function collectErrorNodes(root: Node, limit: number): Node[] {
    const out: Node[] = [];
    const visit = (node: Node): void => {
        if (out.length >= limit) {
            return;
        }
        let childHasError = false;
        for (let i = 0; i < node.childCount; i++) {
            const c = node.child(i);
            if (c && (c.isError || c.isMissing || c.hasError)) {
                childHasError = true;
                break;
            }
        }
        if ((node.isError || node.isMissing) && !childHasError) {
            out.push(node);
            return;
        }
        for (let i = 0; i < node.childCount; i++) {
            const c = node.child(i);
            if (c) {
                visit(c);
            }
        }
    };
    visit(root);
    return out;
}

// tree-sitter's error recovery is unreliable *after* the first break — it
// tends to misattribute a cascade of downstream errors to a single real
// mistake. The earliest error node is reliably located, so we report just that
// one per block and let the author fix and re-run.
const MAX_DIAGS_PER_BLOCK = 1;

// Produce syntax diagnostics for every shader block in the document. Returns []
// if the parser isn't ready yet (the caller re-runs once init resolves).
export function getShaderDiagnostics(doc: vscode.TextDocument): vscode.Diagnostic[] {
    if (!parser) {
        return [];
    }

    const diags: vscode.Diagnostic[] = [];
    for (const prefix of SHADER_PREFIXES) {
        const assembled = reassemble(doc, prefix);
        if (!assembled) {
            continue;
        }
        // A gap truncates the block at load time; the assembled fragment would
        // be missing its tail (e.g. the closing `}`), producing a misleading
        // whole-block parse error. Defer to the gap-truncation diagnostic.
        if (assembled.truncated) {
            continue;
        }
        const tree = parser.parse(normalize(assembled.source));
        if (!tree || !tree.rootNode.hasError) {
            continue;
        }

        for (const node of collectErrorNodes(tree.rootNode, MAX_DIAGS_PER_BLOCK)) {
            const startRow = node.startPosition.row;
            const endRow = Math.min(node.endPosition.row, assembled.rows.length - 1);
            if (startRow >= assembled.rows.length) {
                continue;
            }
            const startMap = assembled.rows[startRow];
            const endMap = assembled.rows[endRow];

            const startCol = startMap.colOffset + node.startPosition.column;
            // Missing tokens are zero-width; widen to the end of the line so the
            // squiggle is visible rather than a bare caret.
            const startLineLen = doc.lineAt(startMap.docLine).text.length;
            let endLine = endMap.docLine;
            let endCol = endMap.colOffset + node.endPosition.column;
            if (node.isMissing || endCol <= startCol) {
                endLine = startMap.docLine;
                endCol = startLineLen;
            }
            endCol = Math.min(endCol, doc.lineAt(endLine).text.length);

            const range = new vscode.Range(
                startMap.docLine, Math.min(startCol, startLineLen),
                endLine, endCol
            );

            const token = node.text.trim().replace(/\s+/g, ' ').slice(0, 40);
            const message = node.isMissing
                ? `Shader syntax error: missing '${node.type}'.`
                : `Shader syntax error: unexpected '${token || node.type}'.`;
            const d = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
            d.code = 'milkdrop.shader-syntax';
            d.source = 'milkdrop';
            diags.push(d);
        }
    }
    return diags;
}
