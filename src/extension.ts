import * as vscode from 'vscode';

// ── Decoration type for pink highlight ──────────────────────────────────────
const aiDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 105, 180, 0.18)',
    border: '1px solid rgba(255, 105, 180, 0.5)',
    borderRadius: '3px',
    overviewRulerColor: 'rgba(255, 105, 180, 0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    after: {
        contentText: ' 🤖',
        color: 'rgba(255, 105, 180, 0.9)',
        margin: '0 0 0 4px',
        fontStyle: 'normal',
    },
});

const pasteDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 165, 0, 0.15)',
    border: '1px solid rgba(255, 165, 0, 0.45)',
    borderRadius: '3px',
    overviewRulerColor: 'rgba(255, 165, 0, 0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    after: {
        contentText: ' 📋',
        color: 'rgba(255, 165, 0, 0.9)',
        margin: '0 0 0 4px',
        fontStyle: 'normal',
    },
});

// ── State ────────────────────────────────────────────────────────────────────
interface TrackedRange {
    range: vscode.Range;
    type: 'ai' | 'paste';
    timestamp: number;
    characterCount: number;
}

const trackedRanges = new Map<string, TrackedRange[]>();
let lastEditTime = Date.now();
let statusBarItem: vscode.StatusBarItem;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDocKey(doc: vscode.TextDocument): string {
    return doc.uri.toString();
}

function reapplyDecorations(editor: vscode.TextEditor): void {
    const key = getDocKey(editor.document);
    const ranges = trackedRanges.get(key) ?? [];

    editor.setDecorations(
        aiDecorationType,
        ranges.filter(r => r.type === 'ai').map(r => r.range)
    );
    editor.setDecorations(
        pasteDecorationType,
        ranges.filter(r => r.type === 'paste').map(r => r.range)
    );

    updateStatusBar();
}

function updateStatusBar(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        statusBarItem.hide();
        return;
    }

    const key = getDocKey(editor.document);
    const ranges = trackedRanges.get(key) ?? [];
    const aiCount = ranges.filter(r => r.type === 'ai').length;
    const pasteCount = ranges.filter(r => r.type === 'paste').length;

    if (aiCount === 0 && pasteCount === 0) {
        statusBarItem.text = '$(check) No AI/Paste';
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = `$(robot) ${aiCount} AI  $(clippy) ${pasteCount} Paste`;
        statusBarItem.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.warningBackground'
        );
    }

    statusBarItem.show();
}

/**
 * Heuristics to detect AI-generated code:
 * - Long insert arriving very fast (< 80 ms since last keystroke)
 * - Multi-line with consistent indentation patterns
 * - Contains typical AI boilerplate signatures
 */
function looksLikeAiGenerated(text: string, deltaMs: number): boolean {
    if (text.length < 40) { return false; }

    const isVeryFast = deltaMs < 80;
    const isMultiLine = text.includes('\n');
    const lineCount = text.split('\n').length;

    // Multi-line fast insert — strong signal
    if (isMultiLine && lineCount >= 3 && isVeryFast) { return true; }

    // Single large block inserted instantly
    if (text.length > 150 && deltaMs < 50) { return true; }

    // Structural patterns common in AI output
    const aiPatterns = [
        /\/\*\*[\s\S]*?\*\//,          // JSDoc blocks
        /TODO:|FIXME:|NOTE:/,           // AI loves these comments
        /\bconsole\.log\(["'`]/,        // debug prints with literals
        /function\s+\w+\s*\(.*\)\s*\{/, // complete function signatures
        /=>\s*\{[\s\S]{30,}/,           // arrow functions with body
        /interface\s+\w+\s*\{/,         // TypeScript interface
        /class\s+\w+\s*(extends\s+\w+\s*)?\{/, // class declarations
    ];

    const patternHits = aiPatterns.filter(p => p.test(text)).length;
    if (patternHits >= 2 && isVeryFast) { return true; }
    if (patternHits >= 3) { return true; }

    return false;
}

// Adjusts stored ranges when document content changes (text shifts)
function adjustRangesForEdit(
    ranges: TrackedRange[],
    change: vscode.TextDocumentContentChangeEvent,
    document: vscode.TextDocument
): TrackedRange[] {
    const changeStart = change.range.start;
    const insertedLines = change.text.split('\n').length - 1;
    const removedLines = change.range.end.line - change.range.start.line;
    const lineDelta = insertedLines - removedLines;

    return ranges
        .map(tracked => {
            const { range } = tracked;

            // Remove ranges that were overwritten
            if (
                range.start.line >= changeStart.line &&
                range.end.line <= change.range.end.line &&
                change.text === ''
            ) {
                return null;
            }

            // Shift ranges that come after the edit
            if (range.start.line > change.range.end.line) {
                return {
                    ...tracked,
                    range: new vscode.Range(
                        range.start.line + lineDelta,
                        range.start.character,
                        range.end.line + lineDelta,
                        range.end.character
                    ),
                };
            }

            return tracked;
        })
        .filter((r): r is TrackedRange => r !== null);
}

// ── Main activation ──────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext): void {
    vscode.window.showInformationMessage('🛡️ AI/Paste Detector active');

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'aiDetector.showSummary';
    statusBarItem.tooltip = 'Click to see AI/Paste summary';
    context.subscriptions.push(statusBarItem);

    // ── Listener: text changes ───────────────────────────────────────────────
    const changeDisposable = vscode.workspace.onDidChangeTextDocument(
        async (event) => {
            const editor = vscode.window.visibleTextEditors.find(
                e => e.document === event.document
            );
            if (!editor) { return; }

            const now = Date.now();
            const delta = now - lastEditTime;
            let clipboard: string;

            try {
                clipboard = await vscode.env.clipboard.readText();
            } catch {
                clipboard = '';
            }

            const key = getDocKey(event.document);
            let ranges = trackedRanges.get(key) ?? [];

            for (const change of event.contentChanges) {
                const text = change.text;
                if (!text || text.trim().length === 0) {
                    // Deletion — adjust existing ranges
                    ranges = adjustRangesForEdit(ranges, change, event.document);
                    continue;
                }

                const isFromClipboard =
                    clipboard.length > 0 &&
                    (text === clipboard || text.trim() === clipboard.trim());

                const isAi = !isFromClipboard && looksLikeAiGenerated(text, delta);
                const isPaste = isFromClipboard && text.length > 20;

                if (isAi || isPaste) {
                    // Compute the range of the inserted text
                    const startPos = change.range.start;
                    const insertedLines = text.split('\n');
                    const endLine = startPos.line + insertedLines.length - 1;
                    const endChar =
                        insertedLines.length === 1
                            ? startPos.character + text.length
                            : insertedLines[insertedLines.length - 1].length;

                    const insertedRange = new vscode.Range(
                        startPos.line,
                        startPos.character,
                        endLine,
                        endChar
                    );

                    ranges = adjustRangesForEdit(ranges, change, event.document);
                    ranges.push({
                        range: insertedRange,
                        type: isAi ? 'ai' : 'paste',
                        timestamp: now,
                        characterCount: text.length,
                    });

                    const label = isAi ? '🤖 AI-generated code' : '📋 Paste';
                    vscode.window.setStatusBarMessage(
                        `${label} detected — ${text.length} chars`,
                        3000
                    );
                } else {
                    ranges = adjustRangesForEdit(ranges, change, event.document);
                }
            }

            trackedRanges.set(key, ranges);
            reapplyDecorations(editor);
            lastEditTime = now;
        }
    );

    // ── Listener: editor focus change ────────────────────────────────────────
    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
        (editor) => {
            if (editor) { reapplyDecorations(editor); }
            else { statusBarItem.hide(); }
        }
    );

    // ── Command: clear highlights ────────────────────────────────────────────
    const clearCommand = vscode.commands.registerCommand(
        'aiDetector.clearHighlights',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }

            const key = getDocKey(editor.document);
            trackedRanges.set(key, []);
            reapplyDecorations(editor);
            vscode.window.showInformationMessage('✅ Highlights cleared');
        }
    );

    // ── Command: summary ─────────────────────────────────────────────────────
    const summaryCommand = vscode.commands.registerCommand(
        'aiDetector.showSummary',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active editor');
                return;
            }
            const key = getDocKey(editor.document);
            const ranges = trackedRanges.get(key) ?? [];

            const aiRanges = ranges.filter(r => r.type === 'ai');
            const pasteRanges = ranges.filter(r => r.type === 'paste');
            const totalAiChars = aiRanges.reduce((s, r) => s + r.characterCount, 0);
            const totalPasteChars = pasteRanges.reduce((s, r) => s + r.characterCount, 0);

            const msg =
                ranges.length === 0
                    ? '✅ No AI or paste regions detected in this file.'
                    : `🤖 AI: ${aiRanges.length} region(s), ~${totalAiChars} chars\n` +
                      `📋 Paste: ${pasteRanges.length} region(s), ~${totalPasteChars} chars`;

            vscode.window.showInformationMessage(msg, 'Clear Highlights').then(
                (choice) => {
                    if (choice === 'Clear Highlights') {
                        vscode.commands.executeCommand('aiDetector.clearHighlights');
                    }
                }
            );
        }
    );

    context.subscriptions.push(
        changeDisposable,
        editorChangeDisposable,
        clearCommand,
        summaryCommand,
        aiDecorationType,
        pasteDecorationType
    );

    // Apply to any already-open editor
    if (vscode.window.activeTextEditor) {
        reapplyDecorations(vscode.window.activeTextEditor);
    }
}

export function deactivate(): void {
    trackedRanges.clear();
}
