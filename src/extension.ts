import * as vscode from 'vscode';

// Keys that use the `prefix_NN=` numbering convention and benefit from renumber/dedup.
const INDEXED_PREFIXES = ['comp', 'warp', 'per_frame', 'per_pixel', 'per_frame_init'];
const INDEXED_LINE_RE = new RegExp(
    `^(${INDEXED_PREFIXES.join('|')})_(\\d+)(=.*)$`
);

// Shader-body prefixes append a backtick after `=` to start the embedded HLSL.
const SHADER_PREFIXES = new Set(['comp', 'warp']);

interface IndexedLine {
    lineNumber: number;
    prefix: string;
    index: number;
    rest: string; // includes leading '='
}

function scanIndexedLines(doc: vscode.TextDocument): IndexedLine[] {
    const out: IndexedLine[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text;
        const m = text.match(INDEXED_LINE_RE);
        if (m) {
            out.push({
                lineNumber: i,
                prefix: m[1],
                index: parseInt(m[2], 10),
                rest: m[3]
            });
        }
    }
    return out;
}

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
            const newText = `${l.prefix}_${next}${l.rest}`;
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

// Diagnostics: flag duplicate `<prefix>_<n>=` keys (last-wins overwrite bug).
function refreshDiagnostics(
    doc: vscode.TextDocument,
    collection: vscode.DiagnosticCollection
): void {
    if (doc.languageId !== 'milkdrop') {
        return;
    }
    const seen = new Map<string, IndexedLine>();
    const dups: { first: IndexedLine; second: IndexedLine }[] = [];

    for (const l of scanIndexedLines(doc)) {
        const key = `${l.prefix}_${l.index}`;
        const prev = seen.get(key);
        if (prev) {
            dups.push({ first: prev, second: l });
        } else {
            seen.set(key, l);
        }
    }

    const diags: vscode.Diagnostic[] = [];
    for (const { first, second } of dups) {
        const key = `${second.prefix}_${second.index}`;
        const range = new vscode.Range(
            second.lineNumber, 0,
            second.lineNumber, doc.lineAt(second.lineNumber).text.length
        );
        const d = new vscode.Diagnostic(
            range,
            `Duplicate key '${key}=' (also at line ${first.lineNumber + 1}). The earlier line will be overwritten by this one.`,
            vscode.DiagnosticSeverity.Warning
        );
        d.code = 'milkdrop.duplicate-index';
        diags.push(d);
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

    // Find highest existing index per prefix so we can suggest the next one.
    const highest = new Map<string, number>();
    for (const l of scanIndexedLines(doc)) {
        const cur = highest.get(l.prefix) ?? 0;
        if (l.index > cur) {
            highest.set(l.prefix, l.index);
        }
    }

    const items: vscode.CompletionItem[] = [];
    for (const prefix of INDEXED_PREFIXES) {
        const next = (highest.get(prefix) ?? 0) + 1;
        const isShader = SHADER_PREFIXES.has(prefix);
        const insertText = isShader ? `${prefix}_${next}=\`` : `${prefix}_${next}=`;
        const item = new vscode.CompletionItem(insertText, vscode.CompletionItemKind.Snippet);
        item.insertText = insertText;
        item.detail = isShader ? 'shader body line' : 'indexed expression';
        item.filterText = prefix;
        item.sortText = `0_${prefix}`; // float to the top over generic word completions
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

    // Run diagnostics on open/change/save and for already-open editors.
    if (vscode.window.activeTextEditor) {
        refreshDiagnostics(vscode.window.activeTextEditor.document, collection);
    }
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((d) => refreshDiagnostics(d, collection)),
        vscode.workspace.onDidChangeTextDocument((e) => refreshDiagnostics(e.document, collection)),
        vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri))
    );
}

export function deactivate(): void {}
