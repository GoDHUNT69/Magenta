import * as vscode from 'vscode';

// ── Decoration types ─────────────────────────────────────────────────────────
const aiDecorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(255, 105, 180, 0.07)',
    overviewRulerColor: 'rgba(255, 105, 180, 0.5)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    after: {
        contentText: '  🤖',
        color: 'rgba(255, 105, 180, 0.4)',
        margin: '0 0 0 8px',
        fontStyle: 'italic',
    },
});

const pasteDecorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(255, 200, 0, 0.06)',
    overviewRulerColor: 'rgba(255, 200, 0, 0.5)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    after: {
        contentText: '  📋',
        color: 'rgba(255, 200, 0, 0.4)',
        margin: '0 0 0 8px',
        fontStyle: 'italic',
    },
});

// ── State ────────────────────────────────────────────────────────────────────

/**
 * Tracks a single flagged line (not a range block).
 * Storing per-line rather than per-block fixes issues 2, 3, and 4:
 *  - Issue 2: Typed lines inside a block are never added, so they stay clean.
 *  - Issue 3: Multi-change events add only their own lines, not the gap.
 *  - Issue 4: A set of line numbers deduplicates naturally.
 */
interface TrackedLine {
    line: number;
    type: 'ai' | 'paste';
    timestamp: number;
}

/** Per-document state: a flat array of per-line entries. */
const trackedLines = new Map<string, TrackedLine[]>();
let statusBarItem: vscode.StatusBarItem;

let nextChangeIsPaste = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDocKey(doc: vscode.TextDocument): string {
    return doc.uri.toString();
}

function countDocumentLines(doc: vscode.TextDocument): number {
    let count = 0;
    for (let i = 0; i < doc.lineCount; i++) {
        if (doc.lineAt(i).text.trim().length > 0) { count++; }
    }
    return count;
}

function computePercents(
    doc: vscode.TextDocument,
    lines: TrackedLine[]
): { aiPct: number; pastePct: number; totalLines: number; aiLines: number; pasteLines: number } {
    const totalLines = countDocumentLines(doc);

    const aiSet = new Set(lines.filter(l => l.type === 'ai').map(l => l.line));
    const pasteSet = new Set(lines.filter(l => l.type === 'paste').map(l => l.line));
    const unionSize = new Set([...aiSet, ...pasteSet]).size;

    const aiLines = aiSet.size;
    const pasteLines = pasteSet.size;
    const cappedTotal = Math.max(totalLines, unionSize);

    return {
        totalLines,
        aiLines,
        pasteLines,
        aiPct: cappedTotal === 0 ? 0 : Math.min(100, Math.round((aiLines / cappedTotal) * 100)),
        pastePct: cappedTotal === 0 ? 0 : Math.min(100, Math.round((pasteLines / cappedTotal) * 100)),
    };
}

/**
 * Convert per-line entries into contiguous vscode.Range blocks for decoration.
 * Consecutive lines of the same type are merged into a single range — this is
 * purely a rendering optimisation and does not affect the underlying line data.
 */
function buildDecorationRanges(
    doc: vscode.TextDocument,
    lines: TrackedLine[],
    type: 'ai' | 'paste'
): vscode.Range[] {
    const lineNums = [...new Set(
        lines
            .filter(l => l.type === type && l.line < doc.lineCount)
            .map(l => l.line)
    )].sort((a, b) => a - b);

    const ranges: vscode.Range[] = [];
    let i = 0;
    while (i < lineNums.length) {
        let start = lineNums[i];
        let end = start;
        while (i + 1 < lineNums.length && lineNums[i + 1] === lineNums[i] + 1) {
            i++;
            end = lineNums[i];
        }
        const clampedEnd = Math.min(end, doc.lineCount - 1);
        ranges.push(new vscode.Range(
            start, 0,
            clampedEnd, doc.lineAt(clampedEnd).text.length
        ));
        i++;
    }
    return ranges;
}

function reapplyDecorations(editor: vscode.TextEditor): void {
    const key = getDocKey(editor.document);
    const lines = trackedLines.get(key) ?? [];

    editor.setDecorations(aiDecorationType, buildDecorationRanges(editor.document, lines, 'ai'));
    editor.setDecorations(pasteDecorationType, buildDecorationRanges(editor.document, lines, 'paste'));

    updateStatusBar(editor);
}

function updateStatusBar(editor?: vscode.TextEditor): void {
    const activeEditor = editor ?? vscode.window.activeTextEditor;
    if (!activeEditor) {
        statusBarItem.hide();
        return;
    }

    const key = getDocKey(activeEditor.document);
    const lines = trackedLines.get(key) ?? [];
    const { aiPct, pastePct } = computePercents(activeEditor.document, lines);

    if (aiPct === 0 && pastePct === 0) {
        statusBarItem.text = '$(check) Magenta: 0% AI';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'No AI-generated or pasted code detected.';
    } else {
        statusBarItem.text = `$(robot) ${aiPct}% AI  $(clippy) ${pastePct}% Paste`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.tooltip =
            `Magenta detected:\n` +
            `  🤖 ~${aiPct}% AI-generated lines\n` +
            `  📋 ~${pastePct}% pasted lines\n` +
            `Click for full summary.`;
    }

    statusBarItem.show();
}

// ── Detection ────────────────────────────────────────────────────────────────

function looksLikeGenerated(text: string): boolean {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) { return false; }

    const lineCount = text.split('\n').length;
    const sizeGate = lineCount >= 5 || text.length >= 200;
    if (!sizeGate) { return false; }

    const indents = lines.map(l => { const m = l.match(/^(\s*)/); return m ? m[1] : ''; });
    const allSpaces = indents.every(i => !i.includes('\t'));
    const allTabs = indents.every(i => !i.includes(' ') || i.length === 0);
    const uniformIndent = allSpaces || allTabs;

    const noTrailingSpace = lines.every(l => !/ $/.test(l));

    const nonWs = text.replace(/\s/g, '').length;
    const density = text.length > 0 ? nonWs / text.length : 0;
    const highDensity = density >= 0.45;

    const score = [uniformIndent, noTrailingSpace, highDensity].filter(Boolean).length;
    return score >= 2;
}

function matchesClipboard(text: string, clipboard: string): boolean {
    if (clipboard.length < 10) { return false; }
    const t = text.trim();
    const c = clipboard.trim();
    if (t === c) { return true; }
    if (t.length >= 10 && c.includes(t)) { return true; }
    return false;
}

function classify(text: string, isPasteEvent: boolean, clipboard: string): 'ai' | 'paste' | null {
    if (text.trim().length === 0) { return null; }
    if (isPasteEvent) { return 'paste'; }
    if (matchesClipboard(text, clipboard)) { return 'paste'; }
    if (looksLikeGenerated(text)) { return 'ai'; }
    return null;
}

// ── Range drift correction (per-line) ────────────────────────────────────────

/**
 * Adjusts tracked line numbers after a document change.
 *
 * Fix for Issue 1 (deletion leaves stale highlights):
 *   Lines that fall inside a deleted region are removed, not just shifted.
 *   Previously, only ranges *fully consumed* by a deletion were dropped;
 *   partial overlaps (e.g. backspacing one line out of a multi-line block)
 *   were left in place at their original position.
 *
 * Fix for Issue 2 (typed content inside flagged region stays flagged):
 *   Because state is now per-line, a newly typed line is simply never added
 *   to trackedLines. Only paste/AI insert events add lines. There's no block
 *   that could absorb a typed line.
 *
 * Algorithm:
 *   - A line inside [changeStart.line, changeEnd.line] that was deleted
 *     (change.text === '' or net removal) is dropped.
 *   - A line below changeEnd.line is shifted by lineDelta.
 *   - A line above changeStart.line is untouched.
 */
function adjustLinesForEdit(
    lines: TrackedLine[],
    change: vscode.TextDocumentContentChangeEvent
): TrackedLine[] {
    const changeStartLine = change.range.start.line;
    const changeEndLine = change.range.end.line;
    const insertedLines = change.text.split('\n').length - 1;
    const removedLines = changeEndLine - changeStartLine;
    const lineDelta = insertedLines - removedLines;

    return lines
        .map(tracked => {
            const { line } = tracked;

            // Line is within the edited region
            if (line >= changeStartLine && line <= changeEndLine) {
                // If this was a pure deletion (no inserted text replacing it),
                // remove the tracked line entirely — it no longer exists.
                // If text was inserted (replacement), we keep only lines that
                // map into the newly inserted block; anything beyond the
                // insertion shrinks away. The simplest correct behaviour is to
                // drop all lines in the replaced region and let the insert
                // handler re-add them if the new text is classified.
                return null;
            }

            // Line is below the edit — shift it
            if (line > changeEndLine) {
                return { ...tracked, line: line + lineDelta };
            }

            // Line is above the edit — unchanged
            return tracked;
        })
        .filter((l): l is TrackedLine => l !== null);
}

// ── Activation ───────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext): void {
    vscode.window.showInformationMessage('🛡️ Magenta active');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'aiDetector.showSummary';
    context.subscriptions.push(statusBarItem);

    // ── Paste intercept ──────────────────────────────────────────────────────
    const pasteInterceptCommand = vscode.commands.registerCommand(
        'magenta.pasteIntercept',
        async () => {
            nextChangeIsPaste = true;
            try {
                await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            } finally {
                nextChangeIsPaste = false;
            }
        }
    );

    // ── Text change listener ─────────────────────────────────────────────────
    const changeDisposable = vscode.workspace.onDidChangeTextDocument(
        async (event) => {
            const editor = vscode.window.visibleTextEditors.find(
                e => e.document === event.document
            );
            if (!editor) { return; }

            const isPasteEvent = nextChangeIsPaste;
            nextChangeIsPaste = false;

            let clipboard = '';
            try { clipboard = await vscode.env.clipboard.readText(); } catch { /* ignore */ }

            const key = getDocKey(event.document);
            let lines = trackedLines.get(key) ?? [];

            for (const change of event.contentChanges) {
                const text = change.text;

                // Always adjust first — this handles deletions and shifts
                // before we potentially add new tracked lines for this change.
                lines = adjustLinesForEdit(lines, change);

                if (!text || text.trim().length === 0) { continue; }

                const kind = classify(text, isPasteEvent, clipboard);
                if (kind === null) { continue; }

                // Fix for Issue 3 (gap between non-adjacent multi-cursor inserts flagged):
                //   We track only the lines that were actually inserted by this
                //   specific change, not a range from first-to-last change.
                //   Each change in event.contentChanges is handled independently,
                //   so non-adjacent multi-cursor inserts produce separate, correct
                //   line sets with no gap between them.
                //
                // Fix for Issue 4 (double-highlight when AI code inserted into flagged region):
                //   adjustLinesForEdit drops all tracked lines in the replaced
                //   region before we add the new ones, so there's no accumulation.
                //   Additionally, we use a line-number Set below to deduplicate
                //   before writing back.
                const insertedLineTexts = text.split('\n');
                const startLine = change.range.start.line;

                for (let i = 0; i < insertedLineTexts.length; i++) {
                    const lineText = insertedLineTexts[i];
                    // Skip blank inserted lines — they don't represent real code
                    if (lineText.trim().length === 0) { continue; }
                    lines.push({
                        line: startLine + i,
                        type: kind,
                        timestamp: Date.now(),
                    });
                }

                const insertedCount = insertedLineTexts.length;
                const label = kind === 'ai' ? '🤖 AI-generated' : '📋 Paste';
                vscode.window.setStatusBarMessage(`${label} — ${insertedCount} line(s) flagged`, 3000);
            }

            // Deduplicate: if the same line appears more than once (e.g. two
            // overlapping change events in one batch), keep the latest entry.
            // This is the primary guard for Issue 4.
            const lineMap = new Map<number, TrackedLine>();
            for (const entry of lines) {
                const existing = lineMap.get(entry.line);
                if (!existing || entry.timestamp >= existing.timestamp) {
                    lineMap.set(entry.line, entry);
                }
            }
            lines = [...lineMap.values()].sort((a, b) => a.line - b.line);

            trackedLines.set(key, lines);
            reapplyDecorations(editor);
        }
    );

    // ── Editor focus change ──────────────────────────────────────────────────
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
            trackedLines.set(getDocKey(editor.document), []);
            reapplyDecorations(editor);
            vscode.window.showInformationMessage('✅ Magenta: highlights cleared');
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
            const lines = trackedLines.get(key) ?? [];
            const { aiPct, pastePct, totalLines, aiLines, pasteLines } =
                computePercents(editor.document, lines);

            const msg =
                aiLines === 0 && pasteLines === 0
                    ? '✅ No AI or pasted code detected in this file.'
                    : `🤖 AI-generated: ${aiPct}% (${aiLines} of ${totalLines} lines)\n` +
                      `📋 Pasted: ${pastePct}% (${pasteLines} of ${totalLines} lines)`;

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
        pasteInterceptCommand,
        changeDisposable,
        editorChangeDisposable,
        clearCommand,
        summaryCommand,
        aiDecorationType,
        pasteDecorationType
    );

    if (vscode.window.activeTextEditor) {
        reapplyDecorations(vscode.window.activeTextEditor);
    }
}

export function deactivate(): void {
    trackedLines.clear();
}