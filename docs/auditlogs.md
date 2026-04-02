# Audit File Access Tracking — Implementation Walkthrough

## Summary

Implemented a clean "audit this file" toggle with access tracking. Users can right-click any file in the explorer to start/stop auditing. When an audited file is opened — whether by the user or programmatically by another extension — the event is logged to `.magenta/access-log.jsonl` with a `source` field (`'user'` or `'programmatic'`) as the key signal.

## Changes Made

### [extension.ts](file:///c:/Users/prashantVIT/Desktop/New%20folder/Personal/Magenta/magenta/src/extension.ts)

```diff:extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';

// ── Decoration types ─────────────────────────────────────────────────────────
const aiDecorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(223, 217, 220, 0.07)',
    overviewRulerColor: 'rgba(240, 237, 238, 0.79)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    after: {
        contentText: '  🤖',
        color: 'rgba(230, 222, 226, 0.77)',
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

// ── Config flags ─────────────────────────────────────────────────────────────

/**
 * Set to true to flag snippet expansions (VS Code built-in snippets, Emmet,
 * extension snippets) as AI-generated. Set to false to ignore them entirely.
 *
 * Snippets are natural coding shortcuts, so this defaults to false.
 * Flip to true if your compliance policy requires tracking all non-human-typed
 * insertions regardless of source.
 */
const FLAG_SNIPPETS_AS_AI = false;

// ── Paste / snippet timing window ────────────────────────────────────────────

/**
 * Timestamp (ms) set when magenta.pasteIntercept fires.
 * Any change event arriving within PASTE_WINDOW_MS of this timestamp is
 * treated as a paste — this is robust to multi-event pastes (e.g. multi-cursor)
 * where a boolean flag cleared at the top of the first event would miss the rest.
 */
let pasteInterceptTimestamp = 0;
const PASTE_WINDOW_MS = 150;

/**
 * Same pattern for snippet intercept. Only active when FLAG_SNIPPETS_AS_AI
 * is false — if it's true, snippets fall through to looksLikeGenerated anyway.
 */
let snippetInterceptTimestamp = 0;
const SNIPPET_WINDOW_MS = 150;

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
        const start = lineNums[i];
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

/**
 * Classify a text insert.
 *
 * Priority order:
 *  1. pasteWindow   — keyboard paste (Ctrl+V / Shift+Insert) via timestamp window.
 *                     Using a window instead of a boolean flag means multi-event
 *                     pastes (multi-cursor, large files split across two change
 *                     events) are all correctly classified as paste.
 *  2. snippetWindow — insertSnippet intercept. Only suppresses (returns null)
 *                     when FLAG_SNIPPETS_AS_AI is false. When true, falls through
 *                     to looksLikeGenerated so snippets are flagged as AI.
 *  3. matchesClipboard — catches right-click paste, drag-and-drop, middle-click.
 *                     Runs before looksLikeGenerated so AI-structured text copied
 *                     from an external source is always flagged as paste, not AI.
 *  4. looksLikeGenerated — bulk structured insert with no other match → AI.
 *  5. null          — ignore.
 */
function classify(
    text: string,
    now: number,
    clipboard: string
): 'ai' | 'paste' | null {
    if (text.trim().length === 0) { return null; }

    // 1. Keyboard paste window
    if (now - pasteInterceptTimestamp <= PASTE_WINDOW_MS) { return 'paste'; }

    // 2. Snippet window — suppress or fall through depending on flag
    if (now - snippetInterceptTimestamp <= SNIPPET_WINDOW_MS) {
        if (!FLAG_SNIPPETS_AS_AI) { return null; }
        // FLAG_SNIPPETS_AS_AI = true: fall through to structure detection below
    }

    // 3. Clipboard match — drag-and-drop / right-click paste
    if (matchesClipboard(text, clipboard)) { return 'paste'; }

    // 4. Structure heuristic → AI
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

// ── Persistence ──────────────────────────────────────────────────────────────

/** Schema for per-file JSON metadata in .magenta/files/ */
interface FileMetadata {
    version: number;
    lastUpdated: string;
    totalLines: number;
    aiPct: number;
    pastePct: number;
    flags: Array<{ line: number; type: 'ai' | 'paste'; timestamp: number }>;
}

/** Schema for .magenta/index.json */
interface IndexFile {
    version: number;
    lastUpdated: string;
    files: Record<string, { aiPct: number; pastePct: number; totalLines: number }>;
    aggregate: {
        totalFiles: number;
        totalLines: number;
        aiPct: number;
        pastePct: number;
    };
}

/** Schema for .magenta/config.json */
interface MagentaConfig {
    version: number;
    flagSnippetsAsAI: boolean;
    pasteWindowMs: number;
    ignore: string[];
}

/**
 * Owns all disk I/O for persistent flag storage.
 * Creates and manages the .magenta/ folder structure at the workspace root.
 */
class PersistenceManager {
    private readonly magentaDir: string;
    private readonly wsRoot: string;
    private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private config: MagentaConfig | null = null;

    constructor(workspaceRoot: string) {
        this.wsRoot = workspaceRoot;
        this.magentaDir = path.join(workspaceRoot, '.magenta');
        this._loadConfig();
    }

    // ── Path resolution ──────────────────────────────────────────────────────

    /**
     * Resolve .magenta/files/src/index.ts.json from a document URI string.
     */
    private fileMetaPath(docKey: string): string {
        const filePath = vscode.Uri.parse(docKey).fsPath;
        const relative = path.relative(this.wsRoot, filePath);
        return path.join(this.magentaDir, 'files', relative + '.json');
    }

    /**
     * Get the workspace-relative path for a document URI string.
     */
    private relativePath(docKey: string): string {
        const filePath = vscode.Uri.parse(docKey).fsPath;
        return path.relative(this.wsRoot, filePath).replace(/\\/g, '/');
    }

    // ── Config ───────────────────────────────────────────────────────────────

    private _loadConfig(): void {
        const configPath = path.join(this.magentaDir, 'config.json');
        if (fs.existsSync(configPath)) {
            try {
                this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch {
                this.config = null;
            }
        }
    }

    /**
     * Check if a file should be ignored based on config.json ignore patterns.
     */
    private shouldIgnore(relPath: string): boolean {
        const patterns = this.config?.ignore ?? ['node_modules/**', 'dist/**'];
        return patterns.some(p => minimatch(relPath, p));
    }

    // ── Save (debounced) ─────────────────────────────────────────────────────

    /**
     * Debounced save — don't hammer disk on every keystroke.
     * Waits 500ms after the last call before actually writing.
     */
    saveFile(docKey: string, lines: TrackedLine[], doc: vscode.TextDocument): void {
        const relPath = this.relativePath(docKey);
        if (this.shouldIgnore(relPath)) { return; }

        const existing = this.saveTimers.get(docKey);
        if (existing) { clearTimeout(existing); }

        this.saveTimers.set(docKey, setTimeout(() => {
            this._writeFile(docKey, lines, doc);
            this._updateIndex();
            this.saveTimers.delete(docKey);
        }, 500));
    }

    private _writeFile(docKey: string, lines: TrackedLine[], doc: vscode.TextDocument): void {
        const p = this.fileMetaPath(docKey);
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            const { aiPct, pastePct } = computePercents(doc, lines);
            const payload: FileMetadata = {
                version: 1,
                lastUpdated: new Date().toISOString(),
                totalLines: countDocumentLines(doc),
                aiPct,
                pastePct,
                flags: lines.map(l => ({ line: l.line, type: l.type, timestamp: l.timestamp })),
            };
            fs.writeFileSync(p, JSON.stringify(payload, null, 2));
        } catch {
            // Disk write failed — silently continue (extension still works in-memory)
        }
    }

    // ── Load ─────────────────────────────────────────────────────────────────

    /**
     * Load previously persisted flags for a document.
     * Returns null if no file exists or if the data is corrupt/incompatible.
     */
    loadFile(docKey: string): TrackedLine[] | null {
        const p = this.fileMetaPath(docKey);
        if (!fs.existsSync(p)) { return null; }
        try {
            const raw: FileMetadata = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (raw.version !== 1) { return null; }
            return raw.flags.map(f => ({
                line: f.line,
                type: f.type,
                timestamp: f.timestamp,
            }));
        } catch {
            return null;
        }
    }

    // ── Clear ────────────────────────────────────────────────────────────────

    /**
     * Remove persisted flags for a document and update the index.
     */
    clearFile(docKey: string): void {
        const p = this.fileMetaPath(docKey);
        try {
            if (fs.existsSync(p)) { fs.unlinkSync(p); }
        } catch {
            // Ignore — file may already be gone
        }
        this._updateIndex();
    }

    // ── Rename / Delete ──────────────────────────────────────────────────────

    /**
     * Move the persisted metadata file when a source file is renamed.
     */
    renameFile(oldUri: string, newUri: string): void {
        const oldPath = this.fileMetaPath(oldUri);
        const newPath = this.fileMetaPath(newUri);
        try {
            if (fs.existsSync(oldPath)) {
                fs.mkdirSync(path.dirname(newPath), { recursive: true });
                fs.renameSync(oldPath, newPath);
                this._cleanEmptyDirs(path.dirname(oldPath));
                this._updateIndex();
            }
        } catch {
            // Best-effort — old file becomes orphaned, which is harmless
        }
    }

    /**
     * Remove the persisted metadata file when a source file is deleted.
     */
    deleteFile(docUri: string): void {
        const p = this.fileMetaPath(docUri);
        try {
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                this._cleanEmptyDirs(path.dirname(p));
                this._updateIndex();
            }
        } catch {
            // Ignore
        }
    }

    // ── Index ────────────────────────────────────────────────────────────────

    /**
     * Walk all *.json in .magenta/files/ and rebuild index.json with
     * per-file stats and project-wide aggregates.
     */
    private _updateIndex(): void {
        const filesDir = path.join(this.magentaDir, 'files');
        if (!fs.existsSync(filesDir)) { return; }

        const index: IndexFile = {
            version: 1,
            lastUpdated: new Date().toISOString(),
            files: {},
            aggregate: { totalFiles: 0, totalLines: 0, aiPct: 0, pastePct: 0 },
        };

        let totalAiLines = 0;
        let totalPasteLines = 0;

        this._walkJsonFiles(filesDir, (filePath) => {
            try {
                const raw: FileMetadata = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (raw.version !== 1) { return; }

                // Derive workspace-relative path from the .magenta/files/ path
                const relToFiles = path.relative(filesDir, filePath);
                // Remove trailing .json to get the original relative path
                const relPath = relToFiles.replace(/\.json$/, '').replace(/\\/g, '/');

                index.files[relPath] = {
                    aiPct: raw.aiPct,
                    pastePct: raw.pastePct,
                    totalLines: raw.totalLines,
                };

                index.aggregate.totalFiles++;
                index.aggregate.totalLines += raw.totalLines;

                // Count actual flagged lines for aggregate calculation
                const aiSet = new Set(raw.flags.filter(f => f.type === 'ai').map(f => f.line));
                const pasteSet = new Set(raw.flags.filter(f => f.type === 'paste').map(f => f.line));
                totalAiLines += aiSet.size;
                totalPasteLines += pasteSet.size;
            } catch {
                // Skip corrupt files
            }
        });

        // Compute aggregate percentages
        const totalLines = index.aggregate.totalLines;
        if (totalLines > 0) {
            index.aggregate.aiPct = Math.min(100, Math.round((totalAiLines / totalLines) * 100));
            index.aggregate.pastePct = Math.min(100, Math.round((totalPasteLines / totalLines) * 100));
        }

        try {
            fs.writeFileSync(
                path.join(this.magentaDir, 'index.json'),
                JSON.stringify(index, null, 2)
            );
        } catch {
            // Ignore write failure
        }
    }

    /**
     * Recursively walk a directory and invoke callback for every .json file.
     */
    private _walkJsonFiles(dir: string, callback: (filePath: string) => void): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._walkJsonFiles(fullPath, callback);
            } else if (entry.isFile() && entry.name.endsWith('.json')) {
                callback(fullPath);
            }
        }
    }

    /**
     * Remove empty directories up the tree (cleanup after delete/rename).
     * Stops at the .magenta/files/ root.
     */
    private _cleanEmptyDirs(dir: string): void {
        const filesDir = path.join(this.magentaDir, 'files');
        let current = dir;
        while (current !== filesDir && current.startsWith(filesDir)) {
            try {
                const contents = fs.readdirSync(current);
                if (contents.length === 0) {
                    fs.rmdirSync(current);
                    current = path.dirname(current);
                } else {
                    break;
                }
            } catch {
                break;
            }
        }
    }

    // ── .gitignore ───────────────────────────────────────────────────────────

    /**
     * On first activation when .magenta/ doesn't exist yet, prompt the user
     * about adding it to .gitignore. The answer is stored in workspaceState
     * so the prompt only appears once per workspace.
     */
    async ensureGitignore(context: vscode.ExtensionContext): Promise<void> {
        // Only prompt once per workspace
        const prompted = context.workspaceState.get<boolean>('magenta.gitignorePrompted');
        if (prompted) { return; }

        // Only prompt if .magenta/ doesn't exist yet (first run)
        if (fs.existsSync(this.magentaDir)) { return; }

        const gitignorePath = path.join(this.wsRoot, '.gitignore');

        // Check if .gitignore already contains .magenta/
        if (fs.existsSync(gitignorePath)) {
            const content = fs.readFileSync(gitignorePath, 'utf8');
            if (content.includes('.magenta')) {
                await context.workspaceState.update('magenta.gitignorePrompted', true);
                return;
            }
        }

        const choice = await vscode.window.showInformationMessage(
            'Magenta will create a .magenta/ folder to persist flag data. Add it to .gitignore?',
            'Yes — ignore it', 'No — commit it', 'Remind me later'
        );

        if (choice === 'Yes — ignore it') {
            try {
                fs.appendFileSync(gitignorePath, '\n# Magenta audit data\n.magenta/\n');
                vscode.window.showInformationMessage('✅ Added .magenta/ to .gitignore');
            } catch {
                vscode.window.showWarningMessage('Could not write to .gitignore');
            }
            await context.workspaceState.update('magenta.gitignorePrompted', true);
        } else if (choice === 'No — commit it') {
            await context.workspaceState.update('magenta.gitignorePrompted', true);
            await context.workspaceState.update('magenta.commitFolder', true);
        }
        // 'Remind me later' or dismissed — don't update state, prompt again next time
    }
}

// ── Activation ───────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext): void {
    vscode.window.showInformationMessage('🛡️ Magenta active');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'aiDetector.showSummary';
    context.subscriptions.push(statusBarItem);

    // ── Init persistence (only when a workspace is open) ─────────────────────
    let persistence: PersistenceManager | null = null;
    if (vscode.workspace.workspaceFolders?.length) {
        const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        persistence = new PersistenceManager(wsRoot);
        persistence.ensureGitignore(context); // prompt user once (async, non-blocking)
    }

    // ── Paste intercept ──────────────────────────────────────────────────────
    //
    // Records a timestamp instead of setting a boolean flag. Any change event
    // arriving within PASTE_WINDOW_MS is treated as paste — this correctly
    // handles multi-cursor and multi-event pastes where a boolean cleared at
    // the top of the first event would miss subsequent change events.
    const pasteInterceptCommand = vscode.commands.registerCommand(
        'magenta.pasteIntercept',
        async () => {
            pasteInterceptTimestamp = Date.now();
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        }
    );

    // ── Snippet intercept ─────────────────────────────────────────────────────
    //
    // Hooks editor.action.insertSnippet so snippet expansions are not mistaken
    // for AI-generated code. When FLAG_SNIPPETS_AS_AI is false (default), any
    // change event within SNIPPET_WINDOW_MS is silently ignored. When true,
    // the window has no effect and snippets fall through to looksLikeGenerated.
    //
    // Keybinding for Tab-triggered snippets is handled via package.json just
    // like the paste intercept. Right-click → Insert Snippet and language-server
    // completion snippets that call insertSnippet directly are also caught here.
    const snippetInterceptCommand = vscode.commands.registerCommand(
        'magenta.snippetIntercept',
        async () => {
            snippetInterceptTimestamp = Date.now();
            await vscode.commands.executeCommand('editor.action.insertSnippet');
        }
    );

    // ── Text change listener ─────────────────────────────────────────────────
    const changeDisposable = vscode.workspace.onDidChangeTextDocument(
        async (event) => {
            const editor = vscode.window.visibleTextEditors.find(
                e => e.document === event.document
            );
            if (!editor) { return; }

            // Snapshot the time once per event batch so all changes in this
            // batch are evaluated against the same moment.
            const now = Date.now();

            let clipboard = '';
            try { clipboard = await vscode.env.clipboard.readText(); } catch { /* ignore */ }

            const key = getDocKey(event.document);
            let lines = trackedLines.get(key) ?? [];

            for (const change of event.contentChanges) {
                const text = change.text;

                lines = adjustLinesForEdit(lines, change);

                if (!text || text.trim().length === 0) { continue; }

                const kind = classify(text, now, clipboard);
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

            // Persist to disk (debounced)
            persistence?.saveFile(key, lines, event.document);
        }
    );

    // ── Editor focus change ──────────────────────────────────────────────────
    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
        (editor) => {
            if (!editor) {
                statusBarItem.hide();
                return;
            }

            const key = getDocKey(editor.document);

            // Restore from disk if this file has no in-memory state (fresh session)
            if (!trackedLines.has(key) && persistence) {
                const saved = persistence.loadFile(key);
                if (saved && saved.length > 0) {
                    trackedLines.set(key, saved);
                    vscode.window.setStatusBarMessage('Magenta: restored flags from .magenta/', 2000);
                }
            }

            reapplyDecorations(editor);
        }
    );

    // ── Command: clear highlights ────────────────────────────────────────────
    const clearCommand = vscode.commands.registerCommand(
        'aiDetector.clearHighlights',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const key = getDocKey(editor.document);
            trackedLines.set(key, []);
            reapplyDecorations(editor);
            persistence?.clearFile(key);
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

    // ── File rename handler ──────────────────────────────────────────────────
    const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
        for (const { oldUri, newUri } of event.files) {
            // Update in-memory state
            const oldKey = oldUri.toString();
            const newKey = newUri.toString();
            const existingLines = trackedLines.get(oldKey);
            if (existingLines) {
                trackedLines.set(newKey, existingLines);
                trackedLines.delete(oldKey);
            }
            // Update persisted state
            persistence?.renameFile(oldKey, newKey);
        }
    });

    // ── File delete handler ──────────────────────────────────────────────────
    const deleteDisposable = vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files) {
            const key = uri.toString();
            trackedLines.delete(key);
            persistence?.deleteFile(key);
        }
    });

    context.subscriptions.push(
        pasteInterceptCommand,
        snippetInterceptCommand,
        changeDisposable,
        editorChangeDisposable,
        clearCommand,
        summaryCommand,
        renameDisposable,
        deleteDisposable,
        aiDecorationType,
        pasteDecorationType
    );

    // Restore state for the currently active editor on activation
    if (vscode.window.activeTextEditor) {
        const editor = vscode.window.activeTextEditor;
        const key = getDocKey(editor.document);
        if (!trackedLines.has(key) && persistence) {
            const saved = persistence.loadFile(key);
            if (saved && saved.length > 0) {
                trackedLines.set(key, saved);
                vscode.window.setStatusBarMessage('Magenta: restored flags from .magenta/', 2000);
            }
        }
        reapplyDecorations(editor);
    }
}

export function deactivate(): void {
    trackedLines.clear();
}
===
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';

// ── Decoration types ─────────────────────────────────────────────────────────
const aiDecorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(223, 217, 220, 0.07)',
    overviewRulerColor: 'rgba(240, 237, 238, 0.79)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    after: {
        contentText: '  🤖',
        color: 'rgba(230, 222, 226, 0.77)',
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

interface AuditedFile {
    relativePath: string;
    addedAt: string;       // ISO 8601
}

interface AuditEvent {
    event: 'file-opened';
    file: string;          // workspace-relative path
    timestamp: string;     // ISO 8601
    sessionId: string;     // generated once at activate()
    source: 'user' | 'programmatic';
    activeEditor: string | null;
    openEditors: string[];
}

interface AuditConfig {
    version: 1;
    files: Record<string, AuditedFile>; // key = relativePath
}

/** Per-document state: a flat array of per-line entries. */
const trackedLines = new Map<string, TrackedLine[]>();
let statusBarItem: vscode.StatusBarItem;

// ── Config flags ─────────────────────────────────────────────────────────────

/**
 * Set to true to flag snippet expansions (VS Code built-in snippets, Emmet,
 * extension snippets) as AI-generated. Set to false to ignore them entirely.
 *
 * Snippets are natural coding shortcuts, so this defaults to false.
 * Flip to true if your compliance policy requires tracking all non-human-typed
 * insertions regardless of source.
 */
const FLAG_SNIPPETS_AS_AI = false;

// ── Paste / snippet timing window ────────────────────────────────────────────

/**
 * Timestamp (ms) set when magenta.pasteIntercept fires.
 * Any change event arriving within PASTE_WINDOW_MS of this timestamp is
 * treated as a paste — this is robust to multi-event pastes (e.g. multi-cursor)
 * where a boolean flag cleared at the top of the first event would miss the rest.
 */
let pasteInterceptTimestamp = 0;
const PASTE_WINDOW_MS = 150;

/**
 * Same pattern for snippet intercept. Only active when FLAG_SNIPPETS_AS_AI
 * is false — if it's true, snippets fall through to looksLikeGenerated anyway.
 */
let snippetInterceptTimestamp = 0;
const SNIPPET_WINDOW_MS = 150;

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
        const start = lineNums[i];
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

/**
 * Classify a text insert.
 *
 * Priority order:
 *  1. pasteWindow   — keyboard paste (Ctrl+V / Shift+Insert) via timestamp window.
 *                     Using a window instead of a boolean flag means multi-event
 *                     pastes (multi-cursor, large files split across two change
 *                     events) are all correctly classified as paste.
 *  2. snippetWindow — insertSnippet intercept. Only suppresses (returns null)
 *                     when FLAG_SNIPPETS_AS_AI is false. When true, falls through
 *                     to looksLikeGenerated so snippets are flagged as AI.
 *  3. matchesClipboard — catches right-click paste, drag-and-drop, middle-click.
 *                     Runs before looksLikeGenerated so AI-structured text copied
 *                     from an external source is always flagged as paste, not AI.
 *  4. looksLikeGenerated — bulk structured insert with no other match → AI.
 *  5. null          — ignore.
 */
function classify(
    text: string,
    now: number,
    clipboard: string
): 'ai' | 'paste' | null {
    if (text.trim().length === 0) { return null; }

    // 1. Keyboard paste window
    if (now - pasteInterceptTimestamp <= PASTE_WINDOW_MS) { return 'paste'; }

    // 2. Snippet window — suppress or fall through depending on flag
    if (now - snippetInterceptTimestamp <= SNIPPET_WINDOW_MS) {
        if (!FLAG_SNIPPETS_AS_AI) { return null; }
        // FLAG_SNIPPETS_AS_AI = true: fall through to structure detection below
    }

    // 3. Clipboard match — drag-and-drop / right-click paste
    if (matchesClipboard(text, clipboard)) { return 'paste'; }

    // 4. Structure heuristic → AI
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

// ── Persistence ──────────────────────────────────────────────────────────────

/** Schema for per-file JSON metadata in .magenta/files/ */
interface FileMetadata {
    version: number;
    lastUpdated: string;
    totalLines: number;
    aiPct: number;
    pastePct: number;
    flags: Array<{ line: number; type: 'ai' | 'paste'; timestamp: number }>;
}

/** Schema for .magenta/index.json */
interface IndexFile {
    version: number;
    lastUpdated: string;
    files: Record<string, { aiPct: number; pastePct: number; totalLines: number }>;
    aggregate: {
        totalFiles: number;
        totalLines: number;
        aiPct: number;
        pastePct: number;
    };
}

/** Schema for .magenta/config.json */
interface MagentaConfig {
    version: number;
    flagSnippetsAsAI: boolean;
    pasteWindowMs: number;
    ignore: string[];
}

/**
 * Owns all disk I/O for persistent flag storage.
 * Creates and manages the .magenta/ folder structure at the workspace root.
 */
class PersistenceManager {
    private readonly magentaDir: string;
    private readonly wsRoot: string;
    private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private config: MagentaConfig | null = null;

    constructor(workspaceRoot: string) {
        this.wsRoot = workspaceRoot;
        this.magentaDir = path.join(workspaceRoot, '.magenta');
        this._loadConfig();
    }

    // ── Path resolution ──────────────────────────────────────────────────────

    /**
     * Resolve .magenta/files/src/index.ts.json from a document URI string.
     */
    private fileMetaPath(docKey: string): string {
        const filePath = vscode.Uri.parse(docKey).fsPath;
        const relative = path.relative(this.wsRoot, filePath);
        return path.join(this.magentaDir, 'files', relative + '.json');
    }

    /**
     * Get the workspace-relative path for a document URI string.
     */
    private relativePath(docKey: string): string {
        const filePath = vscode.Uri.parse(docKey).fsPath;
        return path.relative(this.wsRoot, filePath).replace(/\\/g, '/');
    }

    // ── Config ───────────────────────────────────────────────────────────────

    private _loadConfig(): void {
        const configPath = path.join(this.magentaDir, 'config.json');
        if (fs.existsSync(configPath)) {
            try {
                this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch {
                this.config = null;
            }
        }
    }

    /**
     * Check if a file should be ignored based on config.json ignore patterns.
     */
    private shouldIgnore(relPath: string): boolean {
        const patterns = this.config?.ignore ?? ['node_modules/**', 'dist/**'];
        return patterns.some(p => minimatch(relPath, p));
    }

    // ── Save (debounced) ─────────────────────────────────────────────────────

    /**
     * Debounced save — don't hammer disk on every keystroke.
     * Waits 500ms after the last call before actually writing.
     */
    saveFile(docKey: string, lines: TrackedLine[], doc: vscode.TextDocument): void {
        const relPath = this.relativePath(docKey);
        if (this.shouldIgnore(relPath)) { return; }

        const existing = this.saveTimers.get(docKey);
        if (existing) { clearTimeout(existing); }

        this.saveTimers.set(docKey, setTimeout(() => {
            this._writeFile(docKey, lines, doc);
            this._updateIndex();
            this.saveTimers.delete(docKey);
        }, 500));
    }

    private _writeFile(docKey: string, lines: TrackedLine[], doc: vscode.TextDocument): void {
        const p = this.fileMetaPath(docKey);
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            const { aiPct, pastePct } = computePercents(doc, lines);
            const payload: FileMetadata = {
                version: 1,
                lastUpdated: new Date().toISOString(),
                totalLines: countDocumentLines(doc),
                aiPct,
                pastePct,
                flags: lines.map(l => ({ line: l.line, type: l.type, timestamp: l.timestamp })),
            };
            fs.writeFileSync(p, JSON.stringify(payload, null, 2));
        } catch {
            // Disk write failed — silently continue (extension still works in-memory)
        }
    }

    // ── Load ─────────────────────────────────────────────────────────────────

    /**
     * Load previously persisted flags for a document.
     * Returns null if no file exists or if the data is corrupt/incompatible.
     */
    loadFile(docKey: string): TrackedLine[] | null {
        const p = this.fileMetaPath(docKey);
        if (!fs.existsSync(p)) { return null; }
        try {
            const raw: FileMetadata = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (raw.version !== 1) { return null; }
            return raw.flags.map(f => ({
                line: f.line,
                type: f.type,
                timestamp: f.timestamp,
            }));
        } catch {
            return null;
        }
    }

    // ── Clear ────────────────────────────────────────────────────────────────

    /**
     * Remove persisted flags for a document and update the index.
     */
    clearFile(docKey: string): void {
        const p = this.fileMetaPath(docKey);
        try {
            if (fs.existsSync(p)) { fs.unlinkSync(p); }
        } catch {
            // Ignore — file may already be gone
        }
        this._updateIndex();
    }

    // ── Rename / Delete ──────────────────────────────────────────────────────

    /**
     * Move the persisted metadata file when a source file is renamed.
     */
    renameFile(oldUri: string, newUri: string): void {
        const oldPath = this.fileMetaPath(oldUri);
        const newPath = this.fileMetaPath(newUri);
        try {
            if (fs.existsSync(oldPath)) {
                fs.mkdirSync(path.dirname(newPath), { recursive: true });
                fs.renameSync(oldPath, newPath);
                this._cleanEmptyDirs(path.dirname(oldPath));
                this._updateIndex();
            }
        } catch {
            // Best-effort — old file becomes orphaned, which is harmless
        }
    }

    /**
     * Remove the persisted metadata file when a source file is deleted.
     */
    deleteFile(docUri: string): void {
        const p = this.fileMetaPath(docUri);
        try {
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                this._cleanEmptyDirs(path.dirname(p));
                this._updateIndex();
            }
        } catch {
            // Ignore
        }
    }

    // ── Index ────────────────────────────────────────────────────────────────

    /**
     * Walk all *.json in .magenta/files/ and rebuild index.json with
     * per-file stats and project-wide aggregates.
     */
    private _updateIndex(): void {
        const filesDir = path.join(this.magentaDir, 'files');
        if (!fs.existsSync(filesDir)) { return; }

        const index: IndexFile = {
            version: 1,
            lastUpdated: new Date().toISOString(),
            files: {},
            aggregate: { totalFiles: 0, totalLines: 0, aiPct: 0, pastePct: 0 },
        };

        let totalAiLines = 0;
        let totalPasteLines = 0;

        this._walkJsonFiles(filesDir, (filePath) => {
            try {
                const raw: FileMetadata = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (raw.version !== 1) { return; }

                // Derive workspace-relative path from the .magenta/files/ path
                const relToFiles = path.relative(filesDir, filePath);
                // Remove trailing .json to get the original relative path
                const relPath = relToFiles.replace(/\.json$/, '').replace(/\\/g, '/');

                index.files[relPath] = {
                    aiPct: raw.aiPct,
                    pastePct: raw.pastePct,
                    totalLines: raw.totalLines,
                };

                index.aggregate.totalFiles++;
                index.aggregate.totalLines += raw.totalLines;

                // Count actual flagged lines for aggregate calculation
                const aiSet = new Set(raw.flags.filter(f => f.type === 'ai').map(f => f.line));
                const pasteSet = new Set(raw.flags.filter(f => f.type === 'paste').map(f => f.line));
                totalAiLines += aiSet.size;
                totalPasteLines += pasteSet.size;
            } catch {
                // Skip corrupt files
            }
        });

        // Compute aggregate percentages
        const totalLines = index.aggregate.totalLines;
        if (totalLines > 0) {
            index.aggregate.aiPct = Math.min(100, Math.round((totalAiLines / totalLines) * 100));
            index.aggregate.pastePct = Math.min(100, Math.round((totalPasteLines / totalLines) * 100));
        }

        try {
            fs.writeFileSync(
                path.join(this.magentaDir, 'index.json'),
                JSON.stringify(index, null, 2)
            );
        } catch {
            // Ignore write failure
        }
    }

    /**
     * Recursively walk a directory and invoke callback for every .json file.
     */
    private _walkJsonFiles(dir: string, callback: (filePath: string) => void): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._walkJsonFiles(fullPath, callback);
            } else if (entry.isFile() && entry.name.endsWith('.json')) {
                callback(fullPath);
            }
        }
    }

    /**
     * Remove empty directories up the tree (cleanup after delete/rename).
     * Stops at the .magenta/files/ root.
     */
    private _cleanEmptyDirs(dir: string): void {
        const filesDir = path.join(this.magentaDir, 'files');
        let current = dir;
        while (current !== filesDir && current.startsWith(filesDir)) {
            try {
                const contents = fs.readdirSync(current);
                if (contents.length === 0) {
                    fs.rmdirSync(current);
                    current = path.dirname(current);
                } else {
                    break;
                }
            } catch {
                break;
            }
        }
    }

    // ── .gitignore ───────────────────────────────────────────────────────────

    /**
     * On first activation when .magenta/ doesn't exist yet, prompt the user
     * about adding it to .gitignore. The answer is stored in workspaceState
     * so the prompt only appears once per workspace.
     */
    async ensureGitignore(context: vscode.ExtensionContext): Promise<void> {
        // Only prompt once per workspace
        const prompted = context.workspaceState.get<boolean>('magenta.gitignorePrompted');
        if (prompted) { return; }

        // Only prompt if .magenta/ doesn't exist yet (first run)
        if (fs.existsSync(this.magentaDir)) { return; }

        const gitignorePath = path.join(this.wsRoot, '.gitignore');

        // Check if .gitignore already contains .magenta/
        if (fs.existsSync(gitignorePath)) {
            const content = fs.readFileSync(gitignorePath, 'utf8');
            if (content.includes('.magenta')) {
                await context.workspaceState.update('magenta.gitignorePrompted', true);
                return;
            }
        }

        const choice = await vscode.window.showInformationMessage(
            'Magenta will create a .magenta/ folder to persist flag data. Add it to .gitignore?',
            'Yes — ignore it', 'No — commit it', 'Remind me later'
        );

        if (choice === 'Yes — ignore it') {
            try {
                fs.appendFileSync(gitignorePath, '\n# Magenta audit data\n.magenta/\n');
                vscode.window.showInformationMessage('✅ Added .magenta/ to .gitignore');
            } catch {
                vscode.window.showWarningMessage('Could not write to .gitignore');
            }
            await context.workspaceState.update('magenta.gitignorePrompted', true);
        } else if (choice === 'No — commit it') {
            await context.workspaceState.update('magenta.gitignorePrompted', true);
            await context.workspaceState.update('magenta.commitFolder', true);
        }
        // 'Remind me later' or dismissed — don't update state, prompt again next time
    }
}

// ── Session ID ───────────────────────────────────────────────────────────────

function generateSessionId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ── Audited File Manager ─────────────────────────────────────────────────────

class AuditedFileManager {
    private readonly configPath: string;
    private config: AuditConfig = { version: 1, files: {} };

    constructor(private readonly magentaDir: string) {
        this.configPath = path.join(magentaDir, 'audited.json');
        this.load();
    }

    private load(): void {
        if (!fs.existsSync(this.configPath)) { return; }
        try {
            const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            if (raw.version === 1) { this.config = raw; }
        } catch { /* corrupt — start fresh */ }
    }

    private save(): void {
        fs.mkdirSync(this.magentaDir, { recursive: true });
        fs.writeFileSync(
            this.configPath,
            JSON.stringify(this.config, null, 2)
        );
    }

    isAudited(relativePath: string): boolean {
        return relativePath in this.config.files;
    }

    addFile(relativePath: string): void {
        this.config.files[relativePath] = {
            relativePath,
            addedAt: new Date().toISOString()
        };
        this.save();
    }

    removeFile(relativePath: string): void {
        delete this.config.files[relativePath];
        this.save();
    }

    getAll(): AuditedFile[] {
        return Object.values(this.config.files);
    }
}

// ── Audit Logger ─────────────────────────────────────────────────────────────

class AuditLogger {
    private readonly logPath: string;

    constructor(private readonly magentaDir: string) {
        this.logPath = path.join(magentaDir, 'access-log.jsonl');
    }

    log(event: AuditEvent): void {
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n');
    }
}

// ── Activation ───────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext): void {
    vscode.window.showInformationMessage('🛡️ Magenta active');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'aiDetector.showSummary';
    context.subscriptions.push(statusBarItem);

    // ── Init persistence (only when a workspace is open) ─────────────────────
    let persistence: PersistenceManager | null = null;
    let auditedFiles: AuditedFileManager | null = null;
    let auditLogger: AuditLogger | null = null;
    const sessionId = generateSessionId();

    if (vscode.workspace.workspaceFolders?.length) {
        const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        persistence = new PersistenceManager(wsRoot);
        persistence.ensureGitignore(context); // prompt user once (async, non-blocking)

        const magentaDir = path.join(wsRoot, '.magenta');
        auditedFiles = new AuditedFileManager(magentaDir);
        auditLogger  = new AuditLogger(magentaDir);
    }

    // ── Paste intercept ──────────────────────────────────────────────────────
    //
    // Records a timestamp instead of setting a boolean flag. Any change event
    // arriving within PASTE_WINDOW_MS is treated as paste — this correctly
    // handles multi-cursor and multi-event pastes where a boolean cleared at
    // the top of the first event would miss subsequent change events.
    const pasteInterceptCommand = vscode.commands.registerCommand(
        'magenta.pasteIntercept',
        async () => {
            pasteInterceptTimestamp = Date.now();
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        }
    );

    // ── Snippet intercept ─────────────────────────────────────────────────────
    //
    // Hooks editor.action.insertSnippet so snippet expansions are not mistaken
    // for AI-generated code. When FLAG_SNIPPETS_AS_AI is false (default), any
    // change event within SNIPPET_WINDOW_MS is silently ignored. When true,
    // the window has no effect and snippets fall through to looksLikeGenerated.
    //
    // Keybinding for Tab-triggered snippets is handled via package.json just
    // like the paste intercept. Right-click → Insert Snippet and language-server
    // completion snippets that call insertSnippet directly are also caught here.
    const snippetInterceptCommand = vscode.commands.registerCommand(
        'magenta.snippetIntercept',
        async () => {
            snippetInterceptTimestamp = Date.now();
            await vscode.commands.executeCommand('editor.action.insertSnippet');
        }
    );

    // ── Text change listener ─────────────────────────────────────────────────
    const changeDisposable = vscode.workspace.onDidChangeTextDocument(
        async (event) => {
            const editor = vscode.window.visibleTextEditors.find(
                e => e.document === event.document
            );
            if (!editor) { return; }

            // Snapshot the time once per event batch so all changes in this
            // batch are evaluated against the same moment.
            const now = Date.now();

            let clipboard = '';
            try { clipboard = await vscode.env.clipboard.readText(); } catch { /* ignore */ }

            const key = getDocKey(event.document);
            let lines = trackedLines.get(key) ?? [];

            for (const change of event.contentChanges) {
                const text = change.text;

                lines = adjustLinesForEdit(lines, change);

                if (!text || text.trim().length === 0) { continue; }

                const kind = classify(text, now, clipboard);
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

            // Persist to disk (debounced)
            persistence?.saveFile(key, lines, event.document);
        }
    );

    // ── Editor focus change ──────────────────────────────────────────────────
    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
        (editor) => {
            if (!editor) {
                statusBarItem.hide();
                return;
            }

            const key = getDocKey(editor.document);

            // Restore from disk if this file has no in-memory state (fresh session)
            if (!trackedLines.has(key) && persistence) {
                const saved = persistence.loadFile(key);
                if (saved && saved.length > 0) {
                    trackedLines.set(key, saved);
                    vscode.window.setStatusBarMessage('Magenta: restored flags from .magenta/', 2000);
                }
            }

            reapplyDecorations(editor);
        }
    );

    // ── Command: clear highlights ────────────────────────────────────────────
    const clearCommand = vscode.commands.registerCommand(
        'aiDetector.clearHighlights',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const key = getDocKey(editor.document);
            trackedLines.set(key, []);
            reapplyDecorations(editor);
            persistence?.clearFile(key);
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

    // ── File rename handler ──────────────────────────────────────────────────
    const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
        for (const { oldUri, newUri } of event.files) {
            // Update in-memory state
            const oldKey = oldUri.toString();
            const newKey = newUri.toString();
            const existingLines = trackedLines.get(oldKey);
            if (existingLines) {
                trackedLines.set(newKey, existingLines);
                trackedLines.delete(oldKey);
            }
            // Update persisted state
            persistence?.renameFile(oldKey, newKey);
        }
    });

    // ── File delete handler ──────────────────────────────────────────────────
    const deleteDisposable = vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files) {
            const key = uri.toString();
            trackedLines.delete(key);
            persistence?.deleteFile(key);
        }
    });

    // ── Audit: onDidOpenTextDocument hook ─────────────────────────────────────
    const auditDocOpenDisposable = vscode.workspace.onDidOpenTextDocument(doc => {
        if (!auditedFiles || !auditLogger) { return; }

        // skip virtual documents — git diffs, output panels, untitled files
        if (doc.uri.scheme !== 'file') { return; }

        const rel = vscode.workspace.asRelativePath(doc.uri, false);

        // only track files the user has opted into
        if (!auditedFiles.isAudited(rel)) { return; }

        // a document is 'visibly' opened if it appears in an editor tab
        // if it's in textDocuments but not visibleTextEditors,
        // something else opened it programmatically
        const openedVisibly = vscode.window.visibleTextEditors
            .some(e => e.document.uri.toString() === doc.uri.toString());

        const activeEditor = vscode.window.activeTextEditor
            ? vscode.workspace.asRelativePath(
                vscode.window.activeTextEditor.document.uri, false
              )
            : null;

        const openEditors = vscode.workspace.textDocuments
            .filter(d => d.uri.scheme === 'file')
            .map(d => vscode.workspace.asRelativePath(d.uri, false));

        auditLogger.log({
            event: 'file-opened',
            file: rel,
            timestamp: new Date().toISOString(),
            sessionId,
            source: openedVisibly ? 'user' : 'programmatic',
            activeEditor,
            openEditors
        });

        // only surface a notification for programmatic opens
        // user-opened files don't need a toast — that would be annoying
        if (!openedVisibly) {
            vscode.window.setStatusBarMessage(
                `Magenta: audited file accessed programmatically — ${rel}`,
                4000
            );
        }
    });

    // ── Audit: commands ──────────────────────────────────────────────────────
    const fileDecorationEmitter = new vscode.EventEmitter<vscode.Uri>();

    const addAuditCommand = vscode.commands.registerCommand(
        'magenta.addAudit',
        (uri: vscode.Uri) => {
            if (!auditedFiles) { return; }
            const rel = vscode.workspace.asRelativePath(uri, false);
            auditedFiles.addFile(rel);
            fileDecorationEmitter.fire(uri);
            vscode.window.showInformationMessage(
                `Magenta: now auditing access to ${rel}. ` +
                `Events are logged to .magenta/access-log.jsonl`
            );
        }
    );

    const removeAuditCommand = vscode.commands.registerCommand(
        'magenta.removeAudit',
        (uri: vscode.Uri) => {
            if (!auditedFiles) { return; }
            const rel = vscode.workspace.asRelativePath(uri, false);
            auditedFiles.removeFile(rel);
            fileDecorationEmitter.fire(uri);
            vscode.window.showInformationMessage(
                `Magenta: stopped auditing ${rel}.`
            );
        }
    );

    // ── Audit: file decoration provider ──────────────────────────────────────
    const fileDecorationProvider = vscode.window.registerFileDecorationProvider({
        onDidChangeFileDecorations: fileDecorationEmitter.event,
        provideFileDecoration(uri: vscode.Uri) {
            if (!auditedFiles) { return undefined; }
            const rel = vscode.workspace.asRelativePath(uri, false);
            if (!auditedFiles.isAudited(rel)) { return undefined; }
            return {
                badge: 'A',
                tooltip: 'Magenta: file access is being audited',
                color: new vscode.ThemeColor('magenta.auditedFile')
            };
        }
    });

    // ── Audit: context key for explorer menu toggling ────────────────────────
    const auditContextKeyDisposable = vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor || !auditedFiles) { return; }
        const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
        vscode.commands.executeCommand(
            'setContext',
            'magenta.fileIsAudited',
            auditedFiles.isAudited(rel)
        );
    });

    context.subscriptions.push(
        pasteInterceptCommand,
        snippetInterceptCommand,
        changeDisposable,
        editorChangeDisposable,
        clearCommand,
        summaryCommand,
        renameDisposable,
        deleteDisposable,
        aiDecorationType,
        pasteDecorationType,
        auditDocOpenDisposable,
        addAuditCommand,
        removeAuditCommand,
        fileDecorationProvider,
        fileDecorationEmitter,
        auditContextKeyDisposable
    );

    // Restore state for the currently active editor on activation
    if (vscode.window.activeTextEditor) {
        const editor = vscode.window.activeTextEditor;
        const key = getDocKey(editor.document);
        if (!trackedLines.has(key) && persistence) {
            const saved = persistence.loadFile(key);
            if (saved && saved.length > 0) {
                trackedLines.set(key, saved);
                vscode.window.setStatusBarMessage('Magenta: restored flags from .magenta/', 2000);
            }
        }
        reapplyDecorations(editor);
    }
}

export function deactivate(): void {
    trackedLines.clear();
}
```

**Types added** (after `TrackedLine`):
- `AuditedFile` — entry in the audited files config
- `AuditEvent` — structured log entry with `source: 'user' | 'programmatic'`
- `AuditConfig` — schema for `audited.json`

**Classes added:**
- `AuditedFileManager` — owns `audited.json`, manages which files are audited
- `AuditLogger` — append-only JSONL logger to `access-log.jsonl`

**Function added:**
- `generateSessionId()` — UUID v4 generator tying all events in a VS Code session together

**Hooks wired in `activate()`:**
- `onDidOpenTextDocument` — core detection: checks `visibleTextEditors` to determine `source`
- `onDidChangeActiveTextEditor` — sets `magenta.fileIsAudited` context key for menu toggling
- `magenta.addAudit` / `magenta.removeAudit` commands
- `FileDecorationProvider` — purple `A` badge on audited files

---

### [package.json](file:///c:/Users/prashantVIT/Desktop/New%20folder/Personal/Magenta/magenta/package.json)

```diff:package.json
{
  "name": "magenta",
  "displayName": "Magenta",
  "description": "AI audit and compliance tool — flags AI-generated and pasted code inline.",
  "version": "0.1.0",
  "engines": {
    "vscode": "^1.110.0"
  },
  "categories": [
    "Other",
    "Themes"
  ],
  "activationEvents": [
    "onStartupFinished",
    "onCommand:magenta.pasteIntercept",
    "onCommand:magenta.snippetIntercept"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "themes": [
      {
        "label": "Magenta",
        "uiTheme": "vs-dark",
        "path": "./themes/magenta.json"
      },
      {
        "label": "Magenta Noir",
        "uiTheme": "vs-dark",
        "path": "./themes/magenta-noir.json"
      },
      {
        "label": "Magenta Contrast+",
        "uiTheme": "vs-dark",
        "path": "./themes/magenta-contrast.json"
      },
      {
        "label": "Magenta Cyber",
        "uiTheme": "vs-dark",
        "path": "./themes/magenta-cyber.json"
      }
    ],
    "commands": [
      {
        "command": "aiDetector.clearHighlights",
        "title": "Magenta: Clear Highlights"
      },
      {
        "command": "aiDetector.showSummary",
        "title": "Magenta: Show Summary"
      }
    ],
    "keybindings": [
      {
        "command": "magenta.pasteIntercept",
        "key": "ctrl+v",
        "mac": "cmd+v",
        "when": "editorTextFocus"
      },
      {
        "command": "magenta.pasteIntercept",
        "key": "shift+insert",
        "when": "editorTextFocus"
      },
      {
        "command": "magenta.snippetIntercept",
        "key": "tab",
        "when": "editorTextFocus && hasSnippetCompletions"
      },
      {
        "command": "aiDetector.clearHighlights",
        "key": "ctrl+shift+alt+c",
        "mac": "cmd+shift+alt+c"
      }
    ],
    "configuration": {
      "title": "Magenta",
      "properties": {
        "magenta.flagSnippetsAsAI": {
          "type": "boolean",
          "default": false,
          "description": "When enabled, snippet expansions (Emmet, VS Code built-ins, extension snippets) are flagged as AI-generated."
        },
        "magenta.pasteWindowMs": {
          "type": "number",
          "default": 150,
          "description": "Millisecond window after a paste intercept during which change events are classified as paste."
        },
        "magenta.snippetWindowMs": {
          "type": "number",
          "default": 150,
          "description": "Millisecond window after a snippet intercept during which change events are suppressed."
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run package",
    "compile": "npm run check-types && npm run lint && node esbuild.js",
    "watch": "npm-run-all -p watch:*",
    "watch:esbuild": "node esbuild.js --watch",
    "watch:tsc": "tsc --noEmit --watch --project tsconfig.json",
    "package": "npm run check-types && npm run lint && node esbuild.js --production",
    "compile-tests": "tsc -p . --outDir out",
    "watch-tests": "tsc -p . -w --outDir out",
    "pretest": "npm run compile-tests && npm run compile && npm run lint",
    "check-types": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vscode-test"
  },
  "devDependencies": {
    "@types/minimatch": "^5.1.2",
    "@types/mocha": "^10.0.10",
    "@types/node": "^22.19.15",
    "@types/vscode": "^1.110.0",
    "@vscode/test-cli": "^0.0.12",
    "@vscode/test-electron": "^2.5.2",
    "esbuild": "^0.27.3",
    "eslint": "^9.39.3",
    "npm-run-all": "^4.1.5",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.56.1"
  },
  "overrides": {
    "diff": "^8.0.3",
    "serialize-javascript": "^7.0.5"
  },
  "dependencies": {
    "minimatch": "^10.2.5"
  }
}
===
{
  "name": "magenta",
  "displayName": "Magenta",
  "description": "AI audit and compliance tool — flags AI-generated and pasted code inline.",
  "version": "0.1.0",
  "engines": {
    "vscode": "^1.110.0"
  },
  "categories": [
    "Other",
    "Themes"
  ],
  "activationEvents": [
    "onStartupFinished",
    "onCommand:magenta.pasteIntercept",
    "onCommand:magenta.snippetIntercept"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "themes": [
      {
        "label": "Magenta",
        "uiTheme": "vs-dark",
        "path": "./themes/magenta.json"
      },
      {
        "label": "Magenta Noir",
        "uiTheme": "vs-dark",
        "path": "./themes/magenta-noir.json"
      },
      {
        "label": "Magenta Contrast+",
        "uiTheme": "vs-dark",
        "path": "./themes/magenta-contrast.json"
      },
      {
        "label": "Magenta Cyber",
        "uiTheme": "vs-dark",
        "path": "./themes/magenta-cyber.json"
      }
    ],
    "commands": [
      {
        "command": "aiDetector.clearHighlights",
        "title": "Magenta: Clear Highlights"
      },
      {
        "command": "aiDetector.showSummary",
        "title": "Magenta: Show Summary"
      },
      {
        "command": "magenta.addAudit",
        "title": "Magenta: Audit file access"
      },
      {
        "command": "magenta.removeAudit",
        "title": "Magenta: Stop auditing file access"
      }
    ],
    "menus": {
      "explorer/context": [
        {
          "command": "magenta.addAudit",
          "when": "!magenta.fileIsAudited",
          "group": "magenta@1"
        },
        {
          "command": "magenta.removeAudit",
          "when": "magenta.fileIsAudited",
          "group": "magenta@1"
        }
      ]
    },
    "colors": [
      {
        "id": "magenta.auditedFile",
        "description": "Color for files being audited by Magenta",
        "defaults": {
          "dark": "#c084fc",
          "light": "#9333ea",
          "highContrast": "#ffffff"
        }
      }
    ],
    "keybindings": [
      {
        "command": "magenta.pasteIntercept",
        "key": "ctrl+v",
        "mac": "cmd+v",
        "when": "editorTextFocus"
      },
      {
        "command": "magenta.pasteIntercept",
        "key": "shift+insert",
        "when": "editorTextFocus"
      },
      {
        "command": "magenta.snippetIntercept",
        "key": "tab",
        "when": "editorTextFocus && hasSnippetCompletions"
      },
      {
        "command": "aiDetector.clearHighlights",
        "key": "ctrl+shift+alt+c",
        "mac": "cmd+shift+alt+c"
      }
    ],
    "configuration": {
      "title": "Magenta",
      "properties": {
        "magenta.flagSnippetsAsAI": {
          "type": "boolean",
          "default": false,
          "description": "When enabled, snippet expansions (Emmet, VS Code built-ins, extension snippets) are flagged as AI-generated."
        },
        "magenta.pasteWindowMs": {
          "type": "number",
          "default": 150,
          "description": "Millisecond window after a paste intercept during which change events are classified as paste."
        },
        "magenta.snippetWindowMs": {
          "type": "number",
          "default": 150,
          "description": "Millisecond window after a snippet intercept during which change events are suppressed."
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run package",
    "compile": "npm run check-types && npm run lint && node esbuild.js",
    "watch": "npm-run-all -p watch:*",
    "watch:esbuild": "node esbuild.js --watch",
    "watch:tsc": "tsc --noEmit --watch --project tsconfig.json",
    "package": "npm run check-types && npm run lint && node esbuild.js --production",
    "compile-tests": "tsc -p . --outDir out",
    "watch-tests": "tsc -p . -w --outDir out",
    "pretest": "npm run compile-tests && npm run compile && npm run lint",
    "check-types": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vscode-test"
  },
  "devDependencies": {
    "@types/minimatch": "^5.1.2",
    "@types/mocha": "^10.0.10",
    "@types/node": "^22.19.15",
    "@types/vscode": "^1.110.0",
    "@vscode/test-cli": "^0.0.12",
    "@vscode/test-electron": "^2.5.2",
    "esbuild": "^0.27.3",
    "eslint": "^9.39.3",
    "npm-run-all": "^4.1.5",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.56.1"
  },
  "overrides": {
    "diff": "^8.0.3",
    "serialize-javascript": "^7.0.5"
  },
  "dependencies": {
    "minimatch": "^10.2.5"
  }
}
```

- Two new commands: `magenta.addAudit`, `magenta.removeAudit`
- Explorer context menu entries with `when` clause toggling
- `magenta.auditedFile` theme color (purple, matching Magenta branding)

## Validation

| Check | Result |
|-------|--------|
| `npm run check-types` | ✅ Exit code 0 |
| `npm run compile` (types + lint + esbuild) | ✅ Exit code 0 |
