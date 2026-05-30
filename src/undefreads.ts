import * as vscode from 'vscode';
import { tokenize, reassembleGroup, Token, IndexedCodeLine } from './expr';
import { PoolKind, isBuiltinVar } from './identifiers';
import { IndexedLine } from './indexed';

// "Read but never written" diagnostic. Because the expression language
// auto-declares every bare name, a variable that is *read* somewhere in a pool
// but *assigned* nowhere in that pool can only ever evaluate to 0 — almost
// always a typo (e.g. `bas` for `bass`) or a value the author wrongly expected
// to carry across pools. (Only q1..q32 and reg00..reg99 actually carry; those
// are built-ins and never flagged.)
//
// Scope (v1): the two pools whose variable-sharing is confirmed from the
// projectM source — `per_frame_init`+`per_frame` (one shared eval context) and
// `per_pixel` (its own context). Custom wave/shape pools are intentionally left
// out for now; their cross-block carry rules (t-vars) need the same rigor.

// Operators whose left operand is being assigned (not compared). `==`/`<=`/etc.
// are distinct two-char tokens, so they are correctly excluded.
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=', '|=', '&=']);

interface Pool {
    kind: PoolKind;
    label: string;                 // human name for the diagnostic message
    prefixKeys: ReadonlySet<string>; // `${prefix}${separator}` lowercased
}

const POOLS: Pool[] = [
    {
        kind: 'per_frame',
        label: 'per-frame',
        prefixKeys: new Set(['per_frame_init_', 'per_frame_']),
    },
    {
        kind: 'per_pixel',
        label: 'per-pixel',
        prefixKeys: new Set(['per_pixel_']),
    },
];

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
    // Bucket each block (grouped by prefix) under the pool that owns it.
    const byPool = new Map<Pool, IndexedLine[][]>();
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
    for (const [key, lines] of groups) {
        const pool = POOLS.find((p) => p.prefixKeys.has(key));
        if (!pool) {
            continue;
        }
        const blocks = byPool.get(pool);
        if (blocks) {
            blocks.push(lines);
        } else {
            byPool.set(pool, [lines]);
        }
    }

    const diags: vscode.Diagnostic[] = [];
    for (const [pool, blocks] of byPool) {
        const written = new Set<string>();
        const firstRead = new Map<string, ReadOccurrence>();
        for (const lines of blocks) {
            collectFromBlock(doc, lines, written, firstRead);
        }
        for (const [name, occ] of firstRead) {
            if (written.has(name) || isBuiltinVar(name, pool.kind)) {
                continue;
            }
            const range = new vscode.Range(occ.docLine, occ.startChar, occ.docLine, occ.endChar);
            const d = new vscode.Diagnostic(
                range,
                `'${doc.getText(range)}' is read in the ${pool.label} code but never assigned, so it evaluates to 0. Possible typo or a variable that doesn't carry across pools (only q1..q32 do).`,
                vscode.DiagnosticSeverity.Warning
            );
            d.code = 'milkdrop.undefined-read';
            d.source = 'milkdrop';
            diags.push(d);
        }
    }
    return diags;
}
