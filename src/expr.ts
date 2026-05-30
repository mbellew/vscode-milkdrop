import * as vscode from 'vscode';

// Syntax + light-semantic validation for the MilkDrop per-frame/per-pixel/wave/
// shape expression language (the EEL-style "ns-eel" dialect). This mirrors
// projectM's `projectm-eval` front end exactly enough to flag what its compiler
// would reject:
//
//   - structural syntax errors (unbalanced parens/brackets, stray tokens,
//     malformed expressions);
//   - a registered function used without a call, e.g. `x = sin;`  (the scanner
//     emits a FUNC token and the grammar has no bare-FUNC production);
//   - an unknown name used as a call, e.g. `foo(1)`  (it lexes as a VAR, which
//     the grammar will not let you call);
//   - wrong argument count for a known function (CompilerFunctions.c:133).
//
// What it deliberately does NOT flag: unknown *variables*. Any bare name is an
// auto-declared variable in this language, so flagging them would be wrong.
//
// Ground truth: projectm-eval's Scanner.l (tokens) and Compiler.y (grammar +
// precedence). The precedence ladder below is copied verbatim from Compiler.y.

// Intrinsic functions, lowercased name -> required argument count. Taken from
// projectm-eval/TreeFunctions.c. The internal `/*const*/`/`/*var*/`/… entries
// are omitted: they contain non-identifier characters and can never be lexed.
// `gmem` is also omitted — the scanner emits it as a dedicated keyword (GMEM)
// that must be *indexed* (`gmem[i]`), never called, so it is handled separately.
const FUNCTIONS: ReadonlyMap<string, number> = new Map([
    ['if', 3], ['_if', 3],
    ['_and', 2], ['_or', 2],
    ['loop', 2], ['while', 1],
    ['_not', 1], ['bnot', 1],
    ['_equal', 2], ['equal', 2], ['_noteq', 2],
    ['_below', 2], ['below', 2], ['_above', 2], ['above', 2],
    ['_beleq', 2], ['_aboeq', 2],
    ['_set', 2], ['assign', 2],
    ['_add', 2], ['_sub', 2], ['_mul', 2], ['_div', 2], ['_mod', 2],
    ['_mulop', 2], ['_divop', 2], ['_orop', 2], ['_andop', 2],
    ['_addop', 2], ['_subop', 2], ['_modop', 2], ['_powop', 2],
    ['sin', 1], ['cos', 1], ['tan', 1], ['asin', 1], ['acos', 1],
    ['atan', 1], ['atan2', 2], ['sqr', 1], ['sqrt', 1], ['pow', 2],
    ['exp', 1], ['_neg', 1], ['log', 1], ['log10', 1], ['abs', 1],
    ['min', 2], ['max', 2], ['sign', 1], ['rand', 1], ['floor', 1],
    ['int', 1], ['ceil', 1], ['invsqrt', 1], ['sigmoid', 2],
    ['band', 2], ['bor', 2], ['exec2', 2], ['exec3', 3],
    ['_mem', 1], ['megabuf', 1], ['_gmem', 1], ['gmegabuf', 1],
    ['freembuf', 1], ['memcpy', 3], ['memset', 3],
]);

type TokType =
    | 'num' | 'name' | 'func' | 'gmem'
    | 'op'   // binary/unary operators, value holds the lexeme
    | '(' | ')' | '[' | ']' | '?' | ':' | ',' | ';'
    | 'bad' | 'eof';

interface Token {
    type: TokType;
    value: string;
    line: number;   // 0-based row within the assembled block source
    col: number;    // 0-based column where the token starts
    endCol: number; // column just past the token
}

// Two-character operators, longest first so the scanner is greedy like Flex.
const OP2 = ['+=', '-=', '*=', '/=', '%=', '^=', '|=', '&=', '==', '<=', '>=', '!=', '||', '&&'];
const OP1 = new Set(['<', '>', '+', '-', '*', '/', '%', '^', '&', '|', '!', '=']);

const NUM_RE = /(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/y;
const NAME_RE = /[_a-zA-Z][_a-zA-Z0-9]*/y;
// `$` constants: hex, char literal, or one of the named constants (phi before pi).
const DOLLAR_RE = /\$(?:[xX][0-9a-fA-F]+|'.'|[pP][hH][iI]|[pP][iI]|[eE])/y;

function tokenize(src: string): Token[] {
    const toks: Token[] = [];
    let i = 0;
    let line = 0;
    let lineStart = 0; // source offset of the current line's first char
    const col = (): number => i - lineStart;
    const n = src.length;

    while (i < n) {
        const c = src[i];
        if (c === '\n') {
            i++; line++; lineStart = i; continue;
        }
        if (c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f') {
            i++; continue;
        }
        // Comments: `//` to end of line, `/* */` (possibly multi-line).
        if (c === '/' && src[i + 1] === '/') {
            while (i < n && src[i] !== '\n') {
                i++;
            }
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') { line++; lineStart = i + 1; }
                i++;
            }
            i += 2; // consume the closing */ (harmless if unterminated/at EOF)
            continue;
        }

        const startCol = col();
        const startLine = line;
        const push = (type: TokType, value: string): void => {
            toks.push({ type, value, line: startLine, col: startCol, endCol: col() });
        };

        // `$` numeric constants.
        if (c === '$') {
            DOLLAR_RE.lastIndex = i;
            const m = DOLLAR_RE.exec(src);
            if (m && m.index === i) {
                i += m[0].length; push('num', m[0]); continue;
            }
            i++; push('bad', '$'); continue;
        }

        // Numbers.
        if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
            NUM_RE.lastIndex = i;
            const m = NUM_RE.exec(src)!;
            i += m[0].length; push('num', m[0]); continue;
        }

        // Identifiers, the `gmem` keyword, and function names.
        if (c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
            NAME_RE.lastIndex = i;
            const m = NAME_RE.exec(src)!;
            i += m[0].length;
            const lower = m[0].toLowerCase();
            if (lower === 'gmem') {
                push('gmem', m[0]);
            } else if (FUNCTIONS.has(lower)) {
                push('func', m[0]);
            } else {
                push('name', m[0]);
            }
            continue;
        }

        // Multi- then single-character operators.
        const two = src.slice(i, i + 2);
        if (OP2.includes(two)) {
            i += 2; push('op', two); continue;
        }
        if (OP1.has(c)) {
            i++; push('op', c); continue;
        }
        switch (c) {
            case '(': case ')': case '[': case ']':
            case '?': case ':': case ',': case ';':
                i++; push(c as TokType, c); continue;
        }

        // Anything else is an invalid token (Scanner.l's catch-all -> PRJM_EVAL_UNDEF).
        i++; push('bad', c);
    }

    toks.push({ type: 'eof', value: '', line, col: col(), endCol: col() });
    return toks;
}

// Binding powers, copied from Compiler.y (lowest precedence first there; higher
// number = binds tighter here). Only *infix* operators live in this table;
// prefix `!`/`-`/`+` and postfix `[]` are handled directly in the parser.
interface Bp { prec: number; right: boolean; }
const INFIX: ReadonlyMap<string, Bp> = new Map([
    ['=', { prec: 2, right: true }],
    ['+=', { prec: 3, right: true }], ['-=', { prec: 3, right: true }],
    ['*=', { prec: 4, right: true }], ['/=', { prec: 4, right: true }], ['%=', { prec: 4, right: true }],
    ['^=', { prec: 5, right: true }], ['|=', { prec: 5, right: true }], ['&=', { prec: 5, right: true }],
    // '?' (ternary) is precedence 6, handled specially.
    ['||', { prec: 7, right: false }],
    ['&&', { prec: 8, right: false }],
    ['|', { prec: 9, right: false }],
    ['&', { prec: 10, right: false }],
    ['==', { prec: 11, right: false }], ['!=', { prec: 11, right: false }],
    ['>', { prec: 12, right: false }], ['>=', { prec: 12, right: false }],
    ['<', { prec: 13, right: false }], ['<=', { prec: 13, right: false }],
    ['+', { prec: 14, right: false }], ['-', { prec: 14, right: false }],
    ['*', { prec: 15, right: false }], ['/', { prec: 15, right: false }],
    ['%', { prec: 16, right: false }],
    ['^', { prec: 18, right: false }],
]);
const TERNARY_PREC = 6;
const NOT_PREC = 17;  // unary '!'
const NEG_PREC = 19;  // unary '-' / '+'

interface ParseError {
    message: string;
    line: number; col: number; endLine: number; endCol: number;
}

class Bail {
    constructor(public readonly err: ParseError) {}
}

// Recursive-descent / precedence-climbing parser. Throws Bail on the first
// error (recovery in a tiny expression language buys little and risks misleading
// cascades — the shader validator takes the same one-error-per-block stance).
class Parser {
    private pos = 0;
    constructor(private readonly toks: Token[]) {}

    private peek(): Token { return this.toks[this.pos]; }
    private next(): Token { return this.toks[this.pos++]; }

    private fail(t: Token, message: string): never {
        throw new Bail({ message, line: t.line, col: t.col, endLine: t.line, endCol: Math.max(t.endCol, t.col + 1) });
    }

    private describe(t: Token): string {
        return t.type === 'eof' ? 'end of input' : `'${t.value}'`;
    }

    // program := statement-list? EOF
    parseProgram(): void {
        this.parseStatementList(() => false);
        const t = this.peek();
        if (t.type !== 'eof') {
            this.fail(t, `unexpected ${this.describe(t)}.`);
        }
    }

    // statement-list := expr (';' expr?)*  — empty statements (incl. trailing
    // ';' and bare '()') are tolerated. Returns the number of real expressions.
    private parseStatementList(isEnd: (t: Token) => boolean): number {
        let count = 0;
        for (;;) {
            const t = this.peek();
            if (t.type === 'eof' || isEnd(t)) {
                break;
            }
            if (t.type === ';') {
                this.next(); continue; // empty statement
            }
            if (t.type === '(' && this.toks[this.pos + 1]?.type === ')') {
                this.next(); this.next(); count++; continue; // '()' empty-expression
            }
            this.parseExpr(0);
            count++;
            const sep = this.peek();
            if (sep.type === ';') {
                this.next(); continue;
            }
            if (sep.type === 'eof' || isEnd(sep)) {
                break;
            }
            this.fail(sep, `unexpected ${this.describe(sep)} (missing ';' or operator?).`);
        }
        return count;
    }

    private parseExpr(minPrec: number): void {
        this.parseUnary();
        for (;;) {
            const t = this.peek();
            // Postfix memory index binds tightest; apply whenever present.
            if (t.type === '[') {
                this.next();
                if (this.peek().type !== ']') {
                    this.parseExpr(0);
                }
                this.expect(']');
                continue;
            }
            if (t.type === '?' && TERNARY_PREC >= minPrec) {
                this.next();
                this.parseExpr(0);          // middle stops at ':' (not an infix op)
                this.expect(':');
                this.parseExpr(TERNARY_PREC); // right-assoc
                continue;
            }
            if (t.type === 'op') {
                const bp = INFIX.get(t.value);
                if (bp && bp.prec >= minPrec) {
                    this.next();
                    this.parseExpr(bp.right ? bp.prec : bp.prec + 1);
                    continue;
                }
            }
            break;
        }
    }

    private parseUnary(): void {
        const t = this.peek();
        if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
            this.next(); this.parseExpr(NEG_PREC); return;
        }
        if (t.type === 'op' && t.value === '!') {
            this.next(); this.parseExpr(NOT_PREC); return;
        }
        this.parsePrimary();
    }

    private parsePrimary(): void {
        const t = this.next();
        switch (t.type) {
            case 'num':
            case 'name':
                return;
            case 'gmem':
                // `gmem` must be indexed: `gmem[i]` or `gmem[]`.
                if (this.peek().type !== '[') {
                    this.fail(t, `'gmem' must be indexed, e.g. gmem[0].`);
                }
                return;
            case 'func': {
                if (this.peek().type !== '(') {
                    this.fail(t, `'${t.value}' is a function and must be called with arguments, e.g. ${t.value}(…).`);
                }
                this.next(); // '('
                const args = this.parseArgList(t);
                this.expect(')');
                const expected = FUNCTIONS.get(t.value.toLowerCase())!;
                if (args !== expected) {
                    this.fail(t, `Function '${t.value}' expects ${expected} argument${expected === 1 ? '' : 's'}, but ${args} ${args === 1 ? 'was' : 'were'} given.`);
                }
                return;
            }
            case '(': {
                if (this.peek().type === ')') {
                    this.next(); return; // '()' — tolerated empty expression
                }
                this.parseStatementList((x) => x.type === ')');
                this.expect(')');
                return;
            }
            default:
                this.fail(t, `expected an expression, but found ${this.describe(t)}.`);
        }
    }

    // Comma-separated arguments; each argument is itself a statement-list (it may
    // contain ';'). Returns the argument count. A name immediately followed by
    // '(' that reached here as a call is impossible (only 'func' tokens call), so
    // an empty first argument means a real syntax error.
    private parseArgList(funcTok: Token): number {
        let count = 0;
        for (;;) {
            const before = this.pos;
            const parsed = this.parseStatementList((t) => t.type === ',' || t.type === ')');
            if (parsed === 0 && this.pos === before) {
                // No expression where one is required (e.g. `foo()` or `foo(a,)`).
                const t = this.peek();
                this.fail(t, count === 0
                    ? `'${funcTok.value}' is missing its argument${FUNCTIONS.get(funcTok.value.toLowerCase()) === 1 ? '' : 's'}.`
                    : `expected an argument after ','.`);
            }
            count++;
            if (this.peek().type === ',') {
                this.next(); continue;
            }
            break;
        }
        return count;
    }

    private expect(type: TokType): void {
        const t = this.peek();
        if (t.type !== type) {
            this.fail(t, `expected '${type}', but found ${this.describe(t)}.`);
        }
        this.next();
    }
}

function parseSource(source: string): ParseError | null {
    if (source.trim() === '') {
        return null; // an empty program is valid (Compiler.y: program -> %empty)
    }
    try {
        new Parser(tokenize(source)).parseProgram();
        return null;
    } catch (e) {
        if (e instanceof Bail) {
            return e.err;
        }
        throw e;
    }
}

// One indexed code line, structurally compatible with extension.ts's IndexedLine.
export interface IndexedCodeLine {
    lineNumber: number;
    prefix: string;
    separator: string;
    index: number;
    rest: string; // includes the leading '='
}

// Prefixes whose values are HLSL, not expression code — validated elsewhere.
const SHADER_PREFIXES = new Set(['comp', 'warp']);

interface Assembled {
    source: string;
    rows: { docLine: number; colOffset: number }[];
    truncated: boolean;
}

// Reassemble one block exactly like projectM's GetCode(): first-occurrence wins
// per index, gather 1..N, stop at the first gap, strip one optional leading
// backtick. Tracks each row back to its document line/column for diagnostics.
function reassembleGroup(lines: IndexedCodeLine[]): Assembled {
    const byIndex = new Map<number, IndexedCodeLine>();
    for (const l of lines) {
        if (!byIndex.has(l.index)) {
            byIndex.set(l.index, l);
        }
    }
    const sources: string[] = [];
    const rows: { docLine: number; colOffset: number }[] = [];
    for (let i = 1; byIndex.has(i); i++) {
        const l = byIndex.get(i)!;
        let value = l.rest.startsWith('=') ? l.rest.slice(1) : l.rest;
        // Column where the value starts: key + '='.
        let colOffset = l.prefix.length + l.separator.length + String(l.index).length + 1;
        if (value.startsWith('`')) {
            value = value.slice(1);
            colOffset += 1;
        }
        sources.push(value);
        rows.push({ docLine: l.lineNumber, colOffset });
    }
    return { source: sources.join('\n'), rows, truncated: byIndex.size > sources.length };
}

// Produce expression-syntax diagnostics for every non-shader indexed code block.
// `indexed` is the document's indexed lines (already scanned by the caller).
export function getExpressionDiagnostics(
    doc: vscode.TextDocument,
    indexed: ReadonlyArray<IndexedCodeLine>
): vscode.Diagnostic[] {
    // Group by prefix+separator (lowercased — keys are case-insensitive).
    const groups = new Map<string, IndexedCodeLine[]>();
    for (const l of indexed) {
        if (SHADER_PREFIXES.has(l.prefix.toLowerCase())) {
            continue;
        }
        const key = `${l.prefix}${l.separator}`.toLowerCase();
        const g = groups.get(key);
        if (g) { g.push(l); } else { groups.set(key, [l]); }
    }

    const diags: vscode.Diagnostic[] = [];
    for (const lines of groups.values()) {
        const asm = reassembleGroup(lines);
        // A gap drops the tail at load time; the gap diagnostic owns that case,
        // and validating a truncated fragment would be misleading.
        if (asm.truncated || asm.rows.length === 0) {
            continue;
        }
        const err = parseSource(asm.source);
        if (!err) {
            continue;
        }
        if (err.line >= asm.rows.length) {
            continue;
        }
        const startMap = asm.rows[err.line];
        const endRow = Math.min(err.endLine, asm.rows.length - 1);
        const endMap = asm.rows[endRow];
        const startLineLen = doc.lineAt(startMap.docLine).text.length;
        const startCol = Math.min(startMap.colOffset + err.col, startLineLen);
        let endLine = endMap.docLine;
        let endCol = endMap.colOffset + err.endCol;
        if (endCol <= startMap.colOffset + err.col) {
            endLine = startMap.docLine;
            endCol = startLineLen;
        }
        endCol = Math.min(endCol, doc.lineAt(endLine).text.length);

        const range = new vscode.Range(startMap.docLine, startCol, endLine, endCol);
        const d = new vscode.Diagnostic(range, `Expression syntax error: ${err.message}`, vscode.DiagnosticSeverity.Error);
        d.code = 'milkdrop.expression-syntax';
        d.source = 'milkdrop';
        diags.push(d);
    }
    return diags;
}
