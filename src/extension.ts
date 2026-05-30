import * as vscode from 'vscode';
import { initHlsl, isHlslReady, getShaderDiagnostics } from './hlsl';
import { getExpressionDiagnostics } from './expr';
import { getUndefinedReadDiagnostics } from './undefreads';
import { MilkdropSemanticTokensProvider, SEMANTIC_LEGEND } from './semantic';
import { IndexedLine, matchIndexedLine, scanIndexedLines } from './indexed';

// Pattern A prefixes whose values begin with a backtick to start an embedded shader.
const SHADER_PREFIXES = new Set(['comp', 'warp']);

// Pattern A prefixes always offered as starting points in line-start completion.
const PATTERN_A_PREFIXES = ['per_frame_init', 'per_frame', 'per_pixel', 'warp', 'comp'];

// Renumber: group by prefix and rewrite indices as 1..N in source order.
async function renumberBlocks(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    const lines = scanIndexedLines(doc);
    if (lines.length === 0) {
        vscode.window.showInformationMessage('Milkdrop: no indexed lines found.');
        return;
    }

    // Group by prefix, keeping source order.
    const counters = new Map<string, number>();

    await editor.edit((builder) => {
        for (const l of lines) {
            const next = (counters.get(l.prefix) ?? 0) + 1;
            counters.set(l.prefix, next);
            if (next === l.index) {
                continue; // already correct, skip the edit
            }
            const lineText = doc.lineAt(l.lineNumber).text;
            const newText = `${l.prefix}${l.separator}${next}${l.rest}`;
            const range = new vscode.Range(
                l.lineNumber, 0,
                l.lineNumber, lineText.length
            );
            builder.replace(range, newText);
        }
    });

    const summary = [...counters.entries()]
        .map(([p, n]) => `${p}: ${n}`)
        .join(', ');
    vscode.window.showInformationMessage(`Milkdrop: renumbered (${summary}).`);
}

// The grouping key for a block: prefix + separator, lowercased (keys are
// case-insensitive at load time), e.g. 'comp_', 'per_frame_', 'wave_0_per_point'.
function groupKey(l: IndexedLine): string {
    return `${l.prefix}${l.separator}`.toLowerCase();
}

// Flag duplicate `<prefix>_<n>=` keys. projectM keeps the FIRST occurrence; the
// later line is silently dropped at load time.
function duplicateDiagnostics(doc: vscode.TextDocument, indexed: IndexedLine[]): vscode.Diagnostic[] {
    const seen = new Map<string, IndexedLine>();
    const diags: vscode.Diagnostic[] = [];
    for (const l of indexed) {
        const key = `${l.prefix}${l.separator}${l.index}`.toLowerCase();
        const first = seen.get(key);
        if (!first) {
            seen.set(key, l);
            continue;
        }
        const range = new vscode.Range(
            l.lineNumber, 0,
            l.lineNumber, doc.lineAt(l.lineNumber).text.length
        );
        const d = new vscode.Diagnostic(
            range,
            `Duplicate key '${l.prefix}${l.separator}${l.index}=' (first occurrence on line ${first.lineNumber + 1}). projectM keeps the first occurrence; this line is dropped at load time.`,
            vscode.DiagnosticSeverity.Warning
        );
        d.code = 'milkdrop.duplicate-index';
        diags.push(d);
    }
    return diags;
}

// Flag gap-truncated blocks. projectM's GetCode() loads `<prefix>_1`, `_2`, …
// and STOPS at the first missing index, so any higher-indexed lines that exist
// (often the tail orphaned by a duplicate) are silently dropped at load time.
function gapDiagnostics(doc: vscode.TextDocument, indexed: IndexedLine[]): vscode.Diagnostic[] {
    const groups = new Map<string, IndexedLine[]>();
    for (const l of indexed) {
        const k = groupKey(l);
        const g = groups.get(k);
        if (g) {
            g.push(l);
        } else {
            groups.set(k, [l]);
        }
    }

    const diags: vscode.Diagnostic[] = [];
    for (const lines of groups.values()) {
        const present = new Set(lines.map((l) => l.index));
        // Contiguous run loaded from index 1.
        let run = 0;
        while (present.has(run + 1)) {
            run++;
        }
        const gapIndex = run + 1; // first missing index

        for (const l of lines) {
            if (l.index <= run) {
                continue; // this line loads fine
            }
            const label = `${l.prefix}${l.separator}${l.index}=`;
            const message = run === 0
                ? `'${l.prefix}${l.separator}1=' is missing, so this entire ${l.prefix} block fails to load (projectM starts at index 1).`
                : `'${label}' is dropped at load time: projectM stops at the first missing index ('${l.prefix}${l.separator}${gapIndex}=' is absent). Renumber to close the gap.`;
            const range = new vscode.Range(
                l.lineNumber, 0,
                l.lineNumber, doc.lineAt(l.lineNumber).text.length
            );
            const d = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
            d.code = 'milkdrop.gap-truncation';
            diags.push(d);
        }
    }
    return diags;
}

// Diagnostics: duplicate keys, gap-truncation, and (async) shader syntax.
function refreshDiagnostics(
    doc: vscode.TextDocument,
    collection: vscode.DiagnosticCollection
): void {
    if (doc.languageId !== 'milkdrop') {
        return;
    }
    const indexed = scanIndexedLines(doc);
    const diags: vscode.Diagnostic[] = [];

    diags.push(...duplicateDiagnostics(doc, indexed));
    diags.push(...gapDiagnostics(doc, indexed));

    // Non-built-in names that are read but never assigned (likely typos).
    const undefReadsEnabled = vscode.workspace
        .getConfiguration('milkdrop')
        .get<boolean>('undefinedReadDiagnostics.enable', true);
    if (undefReadsEnabled) {
        diags.push(...getUndefinedReadDiagnostics(doc, indexed));
    }

    // Syntax errors in the per-frame/per-pixel/wave/shape expression code.
    const exprEnabled = vscode.workspace
        .getConfiguration('milkdrop')
        .get<boolean>('expressionDiagnostics.enable', true);
    if (exprEnabled) {
        diags.push(...getExpressionDiagnostics(doc, indexed));
    }

    // HLSL syntax errors in the warp/comp shader blocks. No-op until the WASM
    // parser has finished loading; activate() re-runs diagnostics once it is.
    const shadersEnabled = vscode.workspace
        .getConfiguration('milkdrop')
        .get<boolean>('shaderDiagnostics.enable', true);
    if (shadersEnabled && isHlslReady()) {
        diags.push(...getShaderDiagnostics(doc));
    }

    collection.set(doc.uri, diags);
}

// Suggest `<prefix>_<next>=` (and `=`` for shader prefixes) at line start.
function provideIndexedCompletions(
    doc: vscode.TextDocument,
    position: vscode.Position
): vscode.CompletionItem[] {
    // Only fire at the beginning of a line — the structural slot for these keys.
    const linePrefix = doc.lineAt(position.line).text.substring(0, position.character);
    if (!/^[A-Za-z_]*$/.test(linePrefix)) {
        return [];
    }

    // Highest existing index per (prefix, separator) pair so we can suggest the next one.
    // We key by `${prefix}:${separator}` since the same prefix can never appear with both
    // separators -- but the explicit key makes the dedup intent obvious.
    interface Slot { prefix: string; separator: string; index: number; }
    const highest = new Map<string, Slot>();
    for (const l of scanIndexedLines(doc)) {
        const key = `${l.prefix}:${l.separator}`;
        const cur = highest.get(key);
        if (!cur || l.index > cur.index) {
            highest.set(key, { prefix: l.prefix, separator: l.separator, index: l.index });
        }
    }

    // Always offer the standard Pattern A starting points, even when absent.
    // Pattern B prefixes are only offered when the doc already has at least one such line,
    // so a fresh preset isn't flooded with 24 wave/shape variants the user may not need.
    for (const prefix of PATTERN_A_PREFIXES) {
        const key = `${prefix}:_`;
        if (!highest.has(key)) {
            highest.set(key, { prefix, separator: '_', index: 0 });
        }
    }

    // If the nearest non-blank line above is itself an indexed line, prefer its prefix
    // and use *its* index + 1 (the literal continuation) rather than the block max.
    // This is what the user expects after pressing Enter inside a block.
    let preferred: Slot | null = null;
    for (let i = position.line - 1; i >= 0; i--) {
        const text = doc.lineAt(i).text;
        if (text.trim() === '') {
            continue;
        }
        const parsed = matchIndexedLine(text);
        if (parsed) {
            preferred = { prefix: parsed.prefix, separator: parsed.separator, index: parsed.index };
            // Pin the completion for this prefix to previous-index + 1, even if a higher
            // index exists later in the file (user is inserting between existing lines).
            highest.set(`${preferred.prefix}:${preferred.separator}`, preferred);
        }
        break;
    }

    const items: vscode.CompletionItem[] = [];
    for (const { prefix, separator, index } of highest.values()) {
        const next = index + 1;
        const isShader = separator === '_' && SHADER_PREFIXES.has(prefix);
        const insertText = isShader
            ? `${prefix}${separator}${next}=\``
            : `${prefix}${separator}${next}=`;
        const isPreferred = preferred !== null
            && preferred.prefix === prefix
            && preferred.separator === separator;
        const item = new vscode.CompletionItem(insertText, vscode.CompletionItemKind.Snippet);
        item.insertText = insertText;
        item.detail = isShader ? 'shader body line' : 'indexed expression';
        item.filterText = prefix;
        // Preferred entry sorts above the others (which sort above generic word completions).
        item.sortText = isPreferred ? `00_${prefix}` : `0_${prefix}`;
        item.preselect = isPreferred;
        // Replace whatever the user has typed at the start of the line.
        item.range = new vscode.Range(position.line, 0, position.line, position.character);
        items.push(item);
    }
    return items;
}

export function activate(context: vscode.ExtensionContext): void {
    const collection = vscode.languages.createDiagnosticCollection('milkdrop');
    context.subscriptions.push(collection);

    context.subscriptions.push(
        vscode.commands.registerCommand('milkdrop.renumberBlocks', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'milkdrop') {
                vscode.window.showWarningMessage('Milkdrop: open a .milk file first.');
                return;
            }
            await renumberBlocks(editor);
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'milkdrop' },
            { provideCompletionItems: provideIndexedCompletions }
        )
    );

    // Semantic highlighting: colour built-in variables/functions distinctly so a
    // misspelled built-in (which auto-declares to 0) stands out by losing it.
    if (vscode.workspace.getConfiguration('milkdrop').get<boolean>('semanticHighlighting.enable', true)) {
        context.subscriptions.push(
            vscode.languages.registerDocumentSemanticTokensProvider(
                { language: 'milkdrop' },
                new MilkdropSemanticTokensProvider(),
                SEMANTIC_LEGEND
            )
        );
    }

    // Run diagnostics on open/change/save and for already-open editors.
    const refreshAllOpen = (): void => {
        for (const doc of vscode.workspace.textDocuments) {
            refreshDiagnostics(doc, collection);
        }
    };
    refreshAllOpen();
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((d) => refreshDiagnostics(d, collection)),
        vscode.workspace.onDidChangeTextDocument((e) => refreshDiagnostics(e.document, collection)),
        vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri))
    );

    // Load the HLSL parser in the background; once ready, re-run diagnostics so
    // shader errors appear for files opened before init finished.
    initHlsl(context.extensionPath).then((ok) => {
        if (ok) {
            refreshAllOpen();
        }
    });
}

export function deactivate(): void {}
