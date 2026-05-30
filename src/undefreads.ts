import * as vscode from 'vscode';
import { tokenize, reassembleGroup, Token, IndexedCodeLine } from './expr';
import { PoolKind, poolForPrefix, isBuiltinVar } from './identifiers';
import { IndexedLine } from './indexed';

// "Read but never written" diagnostic. Because the expression language
// auto-declares every bare name, a variable that is *read* somewhere in a pool
// but *assigned* nowhere in that pool can only ever evaluate to 0 — almost
// always a typo (e.g. `bas` for `bass`) or a value the author wrongly expected
// to carry across pools. (Only q1..q32 and t1..t8 and reg00..reg99 actually
// carry; those are built-ins and never flagged.)
//
// Each pool is one projectM eval context (confirmed from source):
//   - per_frame_init + per_frame share one context.
//   - per_pixel is its own context.
//   - each custom wave: init + per_frame share one context; per_point is separate.
//   - each custom shape: init + per_frame share one context.
// User variables do not cross between these contexts, so a name read in one but
// assigned in none of that context's blocks is the bug we flag.

// Operators whose left operand is being assigned (not compared). `==`/`<=`/etc.
// are distinct two-char tokens, so they are correctly excluded.
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=', '|=', '&=']);

// Identify the eval-context pool a block's prefix belongs to: a stable id that
// merges context-sharing blocks (init with per_frame), its PoolKind for built-in
// lookup, and a human label for the message. Returns null for shader/unknown.
function classifyPool(prefix: string): { id: string; kind: PoolKind; label: string } | null {
    const kind = poolForPrefix(prefix);
    if (kind === null) {
        return null;
    }
    const p = prefix.toLowerCase();
    if (p === 'per_frame_init' || p === 'per_frame') {
        return { id: 'per_frame', kind, label: 'per-frame' };
    }
    if (p === 'per_pixel') {
        return { id: 'per_pixel', kind, label: 'per-pixel' };
    }
    const wave = p.match(/^wave_(\d+)_(init|per_frame|per_point)$/);
    if (wave) {
        const n = wave[1];
        return wave[2] === 'per_point'
            ? { id: `wave_${n}_per_point`, kind, label: `custom wave ${n} per-point` }
            : { id: `wave_${n}_per_frame`, kind, label: `custom wave ${n} per-frame` };
    }
    const shape = p.match(/^shape_(\d+)_(init|per_frame)$/);
    if (shape) {
        return { id: `shape_${shape[1]}_per_frame`, kind, label: `custom shape ${shape[1]} per-frame` };
    }
    return null;
}

interface ReadOccurrence {
    docLine: number;
    startChar: number;
    endChar: number;
}

// Scan one block's tokens, recording assigned names into `written` and the first
// read of each name into `firstRead` (mapped to document coordinates).
function collectFromBlock(
    doc: vscode.TextDocument,
    lines: IndexedLine[],
    written: Set<string>,
    firstRead: Map<string, ReadOccurrence>
): void {
    const asm = reassembleGroup(lines as IndexedCodeLine[]);
    const toks: Token[] = tokenize(asm.source);
    for (let i = 0; i < toks.length; i++) {
        const tok = toks[i];
        if (tok.type !== 'name') {
            continue;
        }
        const lower = tok.value.toLowerCase();
        const next = toks[i + 1];
        if (next && next.type === 'op' && ASSIGN_OPS.has(next.value)) {
            written.add(lower);
            continue; // assignment target — not a read
        }
        if (firstRead.has(lower) || tok.line >= asm.rows.length) {
            continue;
        }
        const row = asm.rows[tok.line];
        const lineLen = doc.lineAt(row.docLine).text.length;
        firstRead.set(lower, {
            docLine: row.docLine,
            startChar: Math.min(row.colOffset + tok.col, lineLen),
            endChar: Math.min(row.colOffset + tok.endCol, lineLen),
        });
    }
}

export function getUndefinedReadDiagnostics(
    doc: vscode.TextDocument,
    indexed: ReadonlyArray<IndexedLine>
): vscode.Diagnostic[] {
    // Group indexed lines by prefix, then bucket each block under its eval-context
    // pool (init merges with per_frame; each wave/shape index is independent).
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

    interface Bucket { kind: PoolKind; label: string; blocks: IndexedLine[][]; }
    const byPool = new Map<string, Bucket>();
    for (const lines of groups.values()) {
        const pool = classifyPool(lines[0].prefix);
        if (!pool) {
            continue;
        }
        const bucket = byPool.get(pool.id);
        if (bucket) {
            bucket.blocks.push(lines);
        } else {
            byPool.set(pool.id, { kind: pool.kind, label: pool.label, blocks: [lines] });
        }
    }

    const diags: vscode.Diagnostic[] = [];
    for (const bucket of byPool.values()) {
        const written = new Set<string>();
        const firstRead = new Map<string, ReadOccurrence>();
        for (const lines of bucket.blocks) {
            collectFromBlock(doc, lines, written, firstRead);
        }
        for (const [name, occ] of firstRead) {
            if (written.has(name) || isBuiltinVar(name, bucket.kind)) {
                continue;
            }
            const range = new vscode.Range(occ.docLine, occ.startChar, occ.docLine, occ.endChar);
            const d = new vscode.Diagnostic(
                range,
                `'${doc.getText(range)}' is read in the ${bucket.label} code but never assigned, so it evaluates to 0. Possible typo or a variable that doesn't carry across pools (only q1..q32 do).`,
                vscode.DiagnosticSeverity.Warning
            );
            d.code = 'milkdrop.undefined-read';
            d.source = 'milkdrop';
            diags.push(d);
        }
    }
    return diags;
}
