import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';

// ── Decoration themes ─────────────────────────────────────────────────────────

type ThemeName = 'default' | 'subtle' | 'high-contrast' | 'off';

interface DecorationTheme {
    aiBg: string;
    aiRuler: string;
    aiAfter: vscode.ThemableDecorationAttachmentRenderOptions | undefined;
    pasteBg: string;
    pasteRuler: string;
    pasteAfter: vscode.ThemableDecorationAttachmentRenderOptions | undefined;
}

const THEMES: Record<ThemeName, DecorationTheme> = {
    default: {
        aiBg: 'rgba(223, 217, 220, 0.07)',
        aiRuler: 'rgba(240, 237, 238, 0.79)',
        aiAfter: { contentText: '  🤖', color: 'rgba(230, 222, 226, 0.77)', margin: '0 0 0 8px', fontStyle: 'italic' },
        pasteBg: 'rgba(255, 200, 0, 0.06)',
        pasteRuler: 'rgba(255, 200, 0, 0.5)',
        pasteAfter: { contentText: '  📋', color: 'rgba(255, 200, 0, 0.4)', margin: '0 0 0 8px', fontStyle: 'italic' },
    },
    subtle: {
        aiBg: 'rgba(100, 100, 255, 0.04)',
        aiRuler: 'rgba(100, 100, 255, 0.35)',
        aiAfter: { contentText: '  ·', color: 'rgba(120, 120, 255, 0.5)', margin: '0 0 0 8px' },
        pasteBg: 'rgba(255, 150, 50, 0.04)',
        pasteRuler: 'rgba(255, 150, 50, 0.35)',
        pasteAfter: { contentText: '  ·', color: 'rgba(255, 170, 70, 0.5)', margin: '0 0 0 8px' },
    },
    'high-contrast': {
        aiBg: 'rgba(0, 200, 150, 0.15)',
        aiRuler: 'rgba(0, 200, 150, 1)',
        aiAfter: { contentText: '  ◈ AI', color: 'rgba(0, 220, 170, 0.9)', margin: '0 0 0 8px', fontStyle: 'italic' },
        pasteBg: 'rgba(255, 100, 0, 0.15)',
        pasteRuler: 'rgba(255, 100, 0, 1)',
        pasteAfter: { contentText: '  ◈ Paste', color: 'rgba(255, 140, 0, 0.9)', margin: '0 0 0 8px', fontStyle: 'italic' },
    },
    off: {
        aiBg: 'transparent',
        aiRuler: 'transparent',
        aiAfter: undefined,
        pasteBg: 'transparent',
        pasteRuler: 'transparent',
        pasteAfter: undefined,
    },
};

// ── Decoration type management ────────────────────────────────────────────────

let aiDecorationType: vscode.TextEditorDecorationType;
let pasteDecorationType: vscode.TextEditorDecorationType;
let currentTheme: ThemeName = 'default';
let highlightsVisible = true;

function createDecorationTypes(theme: ThemeName): void {
    aiDecorationType?.dispose();
    pasteDecorationType?.dispose();

    const t = THEMES[theme];

    aiDecorationType = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: t.aiBg,
        overviewRulerColor: t.aiRuler,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        after: t.aiAfter,
    });

    pasteDecorationType = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: t.pasteBg,
        overviewRulerColor: t.pasteRuler,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        after: t.pasteAfter,
    });
}

// ── State ─────────────────────────────────────────────────────────────────────

interface TrackedLine {
    line: number;
    type: 'ai' | 'paste';
    timestamp: number;
}

interface AuditedFile {
    relativePath: string;
    addedAt: string; // ISO 8601
}

interface AuditEvent {
    event: 'file-opened';
    file: string;
    timestamp: string;
    sessionId: string;
    source: 'user' | 'programmatic';
    activeEditor: string | null;
    openEditors: string[];
}

interface AuditConfig {
    version: 1;
    files: Record<string, AuditedFile>;
}

/** Per-document tracked lines, keyed by document URI string. */
const trackedLines = new Map<string, TrackedLine[]>();
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

// ── Dynamic config ────────────────────────────────────────────────────────────

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('magenta');
    return {
        flagSnippetsAsAI: cfg.get<boolean>('flagSnippetsAsAI', false),
        pasteWindowMs:    cfg.get<number>('pasteWindowMs', 150),
        snippetWindowMs:  cfg.get<number>('snippetWindowMs', 150),
    };
}

// ── Paste / snippet timing windows ────────────────────────────────────────────

let pasteInterceptTimestamp  = 0;
let snippetInterceptTimestamp = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function computePercents(doc: vscode.TextDocument, lines: TrackedLine[]) {
    const totalLines = countDocumentLines(doc);
    const aiSet    = new Set(lines.filter(l => l.type === 'ai').map(l => l.line));
    const pasteSet = new Set(lines.filter(l => l.type === 'paste').map(l => l.line));
    const unionSize = new Set([...aiSet, ...pasteSet]).size;
    const cappedTotal = Math.max(totalLines, unionSize);

    return {
        totalLines,
        aiLines:   aiSet.size,
        pasteLines: pasteSet.size,
        aiPct:   cappedTotal === 0 ? 0 : Math.min(100, Math.round((aiSet.size   / cappedTotal) * 100)),
        pastePct: cappedTotal === 0 ? 0 : Math.min(100, Math.round((pasteSet.size / cappedTotal) * 100)),
    };
}

function buildDecorationRanges(doc: vscode.TextDocument, lines: TrackedLine[], type: 'ai' | 'paste'): vscode.Range[] {
    const lineNums = [...new Set(
        lines.filter(l => l.type === type && l.line < doc.lineCount).map(l => l.line)
    )].sort((a, b) => a - b);

    const ranges: vscode.Range[] = [];
    let i = 0;
    while (i < lineNums.length) {
        const start = lineNums[i];
        let end = start;
        while (i + 1 < lineNums.length && lineNums[i + 1] === lineNums[i] + 1) { i++; end = lineNums[i]; }
        const clampedEnd = Math.min(end, doc.lineCount - 1);
        ranges.push(new vscode.Range(start, 0, clampedEnd, doc.lineAt(clampedEnd).text.length));
        i++;
    }
    return ranges;
}

function reapplyDecorations(editor: vscode.TextEditor): void {
    const key   = getDocKey(editor.document);
    const lines = trackedLines.get(key) ?? [];

    if (highlightsVisible) {
        editor.setDecorations(aiDecorationType,    buildDecorationRanges(editor.document, lines, 'ai'));
        editor.setDecorations(pasteDecorationType, buildDecorationRanges(editor.document, lines, 'paste'));
    } else {
        editor.setDecorations(aiDecorationType,    []);
        editor.setDecorations(pasteDecorationType, []);
    }

    updateStatusBar(editor);
}

function reapplyAllEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
        reapplyDecorations(editor);
    }
}

function updateStatusBar(editor?: vscode.TextEditor): void {
    const activeEditor = editor ?? vscode.window.activeTextEditor;
    if (!activeEditor) { statusBarItem.hide(); return; }

    const key   = getDocKey(activeEditor.document);
    const lines = trackedLines.get(key) ?? [];
    const { aiPct, pastePct } = computePercents(activeEditor.document, lines);
    const offSuffix = !highlightsVisible ? ' [off]' : '';

    if (aiPct === 0 && pastePct === 0) {
        statusBarItem.text            = `$(check) Magenta: clean${offSuffix}`;
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip         = 'Magenta: no AI or pasted code detected. Click for options.';
    } else {
        statusBarItem.text            = `$(robot) ${aiPct}% AI  $(clippy) ${pastePct}% Paste${offSuffix}`;
        statusBarItem.backgroundColor = highlightsVisible
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
        statusBarItem.tooltip =
            `Magenta${!highlightsVisible ? ' (highlights hidden)' : ''}:\n` +
            `  🤖 ~${aiPct}% AI-generated\n` +
            `  📋 ~${pastePct}% pasted\n` +
            `Click for summary.`;
    }

    statusBarItem.show();
}

// ── Detection ─────────────────────────────────────────────────────────────────

function looksLikeGenerated(text: string): boolean {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) { return false; }
    if (text.split('\n').length < 5 && text.length < 200) { return false; }

    const indents = lines.map(l => (l.match(/^(\s*)/) ?? ['', ''])[1]);
    const uniformIndent = indents.every(i => !i.includes('\t')) || indents.every(i => !i.includes(' ') || i.length === 0);
    const noTrailingSpace = lines.every(l => !/ $/.test(l));
    const density = text.length > 0 ? text.replace(/\s/g, '').length / text.length : 0;

    return [uniformIndent, noTrailingSpace, density >= 0.45].filter(Boolean).length >= 2;
}

function matchesClipboard(text: string, clipboard: string): boolean {
    if (clipboard.length < 10) { return false; }
    const t = text.trim();
    const c = clipboard.trim();
    return t === c || (t.length >= 10 && c.includes(t));
}

function classify(text: string, now: number, clipboard: string): 'ai' | 'paste' | null {
    if (text.trim().length === 0) { return null; }

    const cfg = getConfig();

    if (now - pasteInterceptTimestamp <= cfg.pasteWindowMs) { return 'paste'; }

    if (now - snippetInterceptTimestamp <= cfg.snippetWindowMs) {
        if (!cfg.flagSnippetsAsAI) { return null; }
        // flagSnippetsAsAI=true → fall through to structure detection
    }

    if (matchesClipboard(text, clipboard)) { return 'paste'; }
    if (looksLikeGenerated(text))          { return 'ai'; }

    return null;
}

// ── Range drift correction ────────────────────────────────────────────────────

function adjustLinesForEdit(lines: TrackedLine[], change: vscode.TextDocumentContentChangeEvent): TrackedLine[] {
    const startLine    = change.range.start.line;
    const endLine      = change.range.end.line;
    const insertedRows = change.text.split('\n').length - 1;
    const removedRows  = endLine - startLine;
    const delta        = insertedRows - removedRows;

    return lines
        .map(tracked => {
            if (tracked.line >= startLine && tracked.line <= endLine) { return null; }
            if (tracked.line > endLine) { return { ...tracked, line: tracked.line + delta }; }
            return tracked;
        })
        .filter((l): l is TrackedLine => l !== null);
}

// ── Persistence ───────────────────────────────────────────────────────────────

interface FileMetadata {
    version: number;
    lastUpdated: string;
    totalLines: number;
    aiPct: number;
    pastePct: number;
    flags: Array<{ line: number; type: 'ai' | 'paste'; timestamp: number }>;
}

interface IndexFile {
    version: number;
    lastUpdated: string;
    files: Record<string, { aiPct: number; pastePct: number; totalLines: number }>;
    aggregate: { totalFiles: number; totalLines: number; aiPct: number; pastePct: number };
}

interface MagentaConfig {
    version: number;
    flagSnippetsAsAI: boolean;
    pasteWindowMs: number;
    ignore: string[];
}

class PersistenceManager {
    private readonly magentaDir: string;
    private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private ignorePatterns: string[] = ['node_modules/**', 'dist/**'];

    constructor(private readonly wsRoot: string) {
        this.magentaDir = path.join(wsRoot, '.magenta');
        this._loadConfig();
    }

    private _fileMetaPath(docKey: string): string {
        const filePath = vscode.Uri.parse(docKey).fsPath;
        return path.join(this.magentaDir, 'files', path.relative(this.wsRoot, filePath) + '.json');
    }

    private _relativePath(docKey: string): string {
        return path.relative(this.wsRoot, vscode.Uri.parse(docKey).fsPath).replace(/\\/g, '/');
    }

    private _loadConfig(): void {
        const p = path.join(this.magentaDir, 'config.json');
        if (!fs.existsSync(p)) { return; }
        try {
            const raw: MagentaConfig = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (Array.isArray(raw.ignore)) { this.ignorePatterns = raw.ignore; }
        } catch { /* use defaults */ }
    }

    private _shouldIgnore(relPath: string): boolean {
        return this.ignorePatterns.some(p => minimatch(relPath, p));
    }

    saveFile(docKey: string, lines: TrackedLine[], doc: vscode.TextDocument): void {
        if (this._shouldIgnore(this._relativePath(docKey))) { return; }
        const existing = this.saveTimers.get(docKey);
        if (existing) { clearTimeout(existing); }
        this.saveTimers.set(docKey, setTimeout(() => {
            this._writeFile(docKey, lines, doc);
            this._updateIndex();
            this.saveTimers.delete(docKey);
        }, 500));
    }

    private _writeFile(docKey: string, lines: TrackedLine[], doc: vscode.TextDocument): void {
        const p = this._fileMetaPath(docKey);
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
        } catch { /* disk write failed — in-memory state intact */ }
    }

    loadFile(docKey: string): TrackedLine[] | null {
        const p = this._fileMetaPath(docKey);
        if (!fs.existsSync(p)) { return null; }
        try {
            const raw: FileMetadata = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (raw.version !== 1) { return null; }
            return raw.flags.map(f => ({ line: f.line, type: f.type as 'ai' | 'paste', timestamp: f.timestamp }));
        } catch { return null; }
    }

    clearFile(docKey: string): void {
        const p = this._fileMetaPath(docKey);
        try { if (fs.existsSync(p)) { fs.unlinkSync(p); } } catch { /* ignore */ }
        this._updateIndex();
    }

    renameFile(oldUri: string, newUri: string): void {
        const oldPath = this._fileMetaPath(oldUri);
        const newPath = this._fileMetaPath(newUri);
        try {
            if (fs.existsSync(oldPath)) {
                fs.mkdirSync(path.dirname(newPath), { recursive: true });
                fs.renameSync(oldPath, newPath);
                this._cleanEmptyDirs(path.dirname(oldPath));
                this._updateIndex();
            }
        } catch { /* best-effort */ }
    }

    deleteFile(docUri: string): void {
        const p = this._fileMetaPath(docUri);
        try {
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                this._cleanEmptyDirs(path.dirname(p));
                this._updateIndex();
            }
        } catch { /* ignore */ }
    }

    private _updateIndex(): void {
        const filesDir = path.join(this.magentaDir, 'files');
        if (!fs.existsSync(filesDir)) { return; }

        const index: IndexFile = {
            version: 1,
            lastUpdated: new Date().toISOString(),
            files: {},
            aggregate: { totalFiles: 0, totalLines: 0, aiPct: 0, pastePct: 0 },
        };

        let totalAi = 0;
        let totalPaste = 0;

        this._walkJsonFiles(filesDir, fp => {
            try {
                const raw: FileMetadata = JSON.parse(fs.readFileSync(fp, 'utf8'));
                if (raw.version !== 1) { return; }
                const rel = path.relative(filesDir, fp).replace(/\.json$/, '').replace(/\\/g, '/');
                index.files[rel] = { aiPct: raw.aiPct, pastePct: raw.pastePct, totalLines: raw.totalLines };
                index.aggregate.totalFiles++;
                index.aggregate.totalLines += raw.totalLines;
                totalAi    += new Set(raw.flags.filter(f => f.type === 'ai').map(f => f.line)).size;
                totalPaste += new Set(raw.flags.filter(f => f.type === 'paste').map(f => f.line)).size;
            } catch { /* skip corrupt */ }
        });

        const t = index.aggregate.totalLines;
        if (t > 0) {
            index.aggregate.aiPct    = Math.min(100, Math.round((totalAi    / t) * 100));
            index.aggregate.pastePct = Math.min(100, Math.round((totalPaste / t) * 100));
        }

        try {
            fs.writeFileSync(path.join(this.magentaDir, 'index.json'), JSON.stringify(index, null, 2));
        } catch { /* ignore */ }
    }

    private _walkJsonFiles(dir: string, cb: (fp: string) => void): void {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { this._walkJsonFiles(full, cb); }
            else if (e.isFile() && e.name.endsWith('.json')) { cb(full); }
        }
    }

    private _cleanEmptyDirs(dir: string): void {
        const filesDir = path.join(this.magentaDir, 'files');
        let current = dir;
        while (current !== filesDir && current.startsWith(filesDir)) {
            try {
                if (fs.readdirSync(current).length === 0) { fs.rmdirSync(current); current = path.dirname(current); }
                else { break; }
            } catch { break; }
        }
    }

    async ensureGitignore(context: vscode.ExtensionContext): Promise<void> {
        if (context.workspaceState.get<boolean>('magenta.gitignorePrompted')) { return; }
        if (fs.existsSync(this.magentaDir)) { return; }

        const gitignorePath = path.join(this.wsRoot, '.gitignore');
        if (fs.existsSync(gitignorePath) && fs.readFileSync(gitignorePath, 'utf8').includes('.magenta')) {
            await context.workspaceState.update('magenta.gitignorePrompted', true);
            return;
        }

        const choice = await vscode.window.showInformationMessage(
            'Magenta will create a .magenta/ folder. Add it to .gitignore?',
            'Yes — ignore it', 'No — commit it', 'Remind me later'
        );

        if (choice === 'Yes — ignore it') {
            try {
                fs.appendFileSync(gitignorePath, '\n# Magenta audit data\n.magenta/\n');
            } catch {
                vscode.window.showWarningMessage('Magenta: could not write to .gitignore');
            }
            await context.workspaceState.update('magenta.gitignorePrompted', true);
        } else if (choice === 'No — commit it') {
            await context.workspaceState.update('magenta.gitignorePrompted', true);
        }
        // 'Remind me later' / dismissed → no-op, prompt again next session
    }
}

// ── Session ID ────────────────────────────────────────────────────────────────

function generateSessionId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ── Audited File Manager ──────────────────────────────────────────────────────

class AuditedFileManager {
    private readonly configPath: string;
    private config: AuditConfig = { version: 1, files: {} };

    constructor(private readonly magentaDir: string) {
        this.configPath = path.join(magentaDir, 'audited.json');
        this._load();
    }

    private _load(): void {
        if (!fs.existsSync(this.configPath)) { return; }
        try {
            const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            if (raw.version === 1) { this.config = raw; }
        } catch { /* start fresh */ }
    }

    private _save(): void {
        try {
            fs.mkdirSync(this.magentaDir, { recursive: true });
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
        } catch { /* ignore */ }
    }

    isAudited(rel: string): boolean { return rel in this.config.files; }

    addFile(rel: string): void {
        this.config.files[rel] = { relativePath: rel, addedAt: new Date().toISOString() };
        this._save();
    }

    removeFile(rel: string): void {
        delete this.config.files[rel];
        this._save();
    }

    renameFile(oldRel: string, newRel: string): void {
        if (!(oldRel in this.config.files)) { return; }
        this.config.files[newRel] = { ...this.config.files[oldRel], relativePath: newRel };
        delete this.config.files[oldRel];
        this._save();
    }

    getAll(): AuditedFile[] { return Object.values(this.config.files); }
}

// ── Audit Logger ──────────────────────────────────────────────────────────────

class AuditLogger {
    private readonly logPath: string;

    constructor(magentaDir: string) {
        this.logPath = path.join(magentaDir, 'access-log.jsonl');
    }

    log(event: AuditEvent): void {
        try {
            fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
            fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n');
        } catch { /* ignore */ }
    }
}

// ── Sidebar WebView Provider ──────────────────────────────────────────────────

class MagentaSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'magenta.sidebar';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly callbacks: {
            getAuditedFiles: () => AuditedFile[];
            onRemoveAudit:   (rel: string) => void;
            onToggleHighlights: () => void;
            onSetTheme:      (theme: ThemeName) => void;
            onClearCurrent:  () => void;
            onShowSummary:   () => void;
        }
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        this._render();

        webviewView.webview.onDidReceiveMessage((msg: { command: string; path?: string; theme?: string }) => {
            switch (msg.command) {
                case 'removeAudit':       this.callbacks.onRemoveAudit(msg.path!); break;
                case 'toggleHighlights':  this.callbacks.onToggleHighlights(); break;
                case 'setTheme':          this.callbacks.onSetTheme(msg.theme as ThemeName); break;
                case 'clearCurrent':      this.callbacks.onClearCurrent(); break;
                case 'showSummary':       this.callbacks.onShowSummary(); break;
            }
        });
    }

    refresh(): void { this._render(); }

    private _render(): void {
        if (this._view) {
            this._view.webview.html = this._buildHtml();
        }
    }

    private _buildHtml(): string {
        const files = this.callbacks.getAuditedFiles();

        const themeOptions: Array<{ id: ThemeName; label: string; icon: string }> = [
            { id: 'default',       label: 'Default',      icon: '●' },
            { id: 'subtle',        label: 'Subtle',        icon: '◉' },
            { id: 'high-contrast', label: 'Hi-Contrast',   icon: '◈' },
            { id: 'off',           label: 'Off',           icon: '○' },
        ];

        const themeButtons = themeOptions.map(t =>
            `<button class="theme-btn${currentTheme === t.id ? ' active' : ''}" data-theme="${t.id}">
                <span class="theme-icon">${t.icon}</span>${t.label}
            </button>`
        ).join('');

        const fileRows = files.length === 0
            ? `<p class="empty-state">No files are being audited.<br>Right-click any file in the Explorer and choose <strong>Magenta: Audit file access</strong>.</p>`
            : files.map(f => {
                const name = f.relativePath.split('/').pop() ?? f.relativePath;
                const dir  = f.relativePath.includes('/') ? f.relativePath.slice(0, f.relativePath.lastIndexOf('/')) : '';
                return `<div class="file-row">
                    <span class="file-icon">🔍</span>
                    <span class="file-info">
                        <span class="file-name" title="${f.relativePath}">${name}</span>
                        ${dir ? `<span class="file-dir">${dir}</span>` : ''}
                    </span>
                    <button class="btn-remove" data-path="${f.relativePath}" title="Stop auditing">✕</button>
                </div>`;
            }).join('');

        const currentEditor = vscode.window.activeTextEditor;
        const currentFile   = currentEditor
            ? (vscode.workspace.asRelativePath(currentEditor.document.uri, false) || 'untitled')
            : null;

        const currentLines  = currentEditor ? (trackedLines.get(getDocKey(currentEditor.document)) ?? []) : [];
        const stats         = currentEditor ? computePercents(currentEditor.document, currentLines) : null;

        const statsHtml = stats
            ? `<div class="stat-row">
                <span class="stat-label">🤖 AI-generated</span>
                <span class="stat-value">${stats.aiPct}% <span class="stat-count">(${stats.aiLines} lines)</span></span>
               </div>
               <div class="stat-row">
                <span class="stat-label">📋 Pasted</span>
                <span class="stat-value">${stats.pastePct}% <span class="stat-count">(${stats.pasteLines} lines)</span></span>
               </div>`
            : `<p class="empty-state">No active editor.</p>`;

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
    font-family:var(--vscode-font-family);
    font-size:var(--vscode-font-size);
    color:var(--vscode-foreground);
    background:transparent;
    padding:0 12px 16px;
    line-height:1.5;
    -webkit-font-smoothing:antialiased;
}
.section{margin-top:16px}
.section-header{
    display:flex;align-items:center;gap:6px;
    font-size:10.5px;font-weight:700;
    text-transform:uppercase;letter-spacing:.1em;
    color:var(--vscode-descriptionForeground);
    margin-bottom:8px;
    padding-bottom:5px;
    border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.2));
}
.section-header-count{
    margin-left:auto;
    font-size:10px;font-weight:400;
    background:var(--vscode-badge-background,rgba(128,128,128,.25));
    color:var(--vscode-badge-foreground);
    border-radius:10px;padding:0 6px;
}
/* Current file */
.current-file{
    font-size:11px;color:var(--vscode-descriptionForeground);
    margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.stat-row{
    display:flex;align-items:center;justify-content:space-between;
    padding:4px 8px;border-radius:4px;margin-bottom:3px;
    background:var(--vscode-list-hoverBackground,rgba(128,128,128,.05));
}
.stat-label{font-size:12px}
.stat-value{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.stat-count{font-weight:400;font-size:11px;color:var(--vscode-descriptionForeground)}
/* Action buttons */
.action-row{display:flex;gap:6px;margin-top:8px}
.btn{
    flex:1;padding:5px 8px;
    background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.12));
    color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));
    border:1px solid transparent;border-radius:4px;
    cursor:pointer;font-size:11px;
    transition:background .1s,border-color .1s;
}
.btn:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(128,128,128,.22))}
.btn.primary{
    background:var(--vscode-button-background);
    color:var(--vscode-button-foreground);
}
.btn.primary:hover{background:var(--vscode-button-hoverBackground)}
/* Highlight toggle */
.toggle-row{
    display:flex;align-items:center;justify-content:space-between;
    padding:6px 10px;border-radius:4px;margin-bottom:8px;
    background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.12));
    border:1px solid ${highlightsVisible ? 'var(--vscode-focusBorder,#007fd4)' : 'transparent'};
    cursor:pointer;font-size:12px;
    transition:background .1s,border-color .1s;
    user-select:none;
}
.toggle-row:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(128,128,128,.22))}
.toggle-label{display:flex;align-items:center;gap:8px}
.badge{
    font-size:10px;font-weight:700;
    padding:1px 7px;border-radius:10px;
    background:${highlightsVisible ? 'rgba(0,200,100,.15)' : 'rgba(128,128,128,.15)'};
    color:${highlightsVisible ? 'var(--vscode-gitDecoration-addedResourceForeground,#73c991)' : 'var(--vscode-descriptionForeground)'};
    letter-spacing:.04em;
}
/* Theme grid */
.theme-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.theme-btn{
    display:flex;align-items:center;gap:6px;
    padding:5px 9px;
    background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.12));
    color:var(--vscode-foreground);
    border:1px solid transparent;border-radius:4px;
    cursor:pointer;font-size:11px;
    transition:background .1s,border-color .1s,color .1s;
}
.theme-btn:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(128,128,128,.22))}
.theme-btn.active{
    border-color:var(--vscode-focusBorder,#007fd4);
    background:rgba(0,127,212,.1);
    color:var(--vscode-focusBorder,#007fd4);
    font-weight:600;
}
.theme-icon{font-style:normal;width:12px;text-align:center}
/* Audit files */
.file-row{
    display:flex;align-items:center;gap:7px;
    padding:5px 7px;border-radius:4px;margin-bottom:3px;
    background:var(--vscode-list-hoverBackground,rgba(128,128,128,.05));
    transition:background .1s;
}
.file-row:hover{background:var(--vscode-list-hoverBackground,rgba(128,128,128,.1))}
.file-icon{font-size:12px;flex-shrink:0}
.file-info{flex:1;min-width:0;display:flex;flex-direction:column}
.file-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-dir{font-size:10px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn-remove{
    flex-shrink:0;width:18px;height:18px;padding:0;
    background:transparent;border:none;border-radius:3px;
    cursor:pointer;font-size:11px;line-height:1;
    color:var(--vscode-descriptionForeground);
    opacity:.5;transition:opacity .1s,background .1s,color .1s;
    display:flex;align-items:center;justify-content:center;
}
.btn-remove:hover{opacity:1;background:rgba(220,50,50,.12);color:var(--vscode-errorForeground,#f48771)}
.empty-state{
    font-size:11px;color:var(--vscode-descriptionForeground);
    line-height:1.7;padding:3px 0;
}
.empty-state strong{color:var(--vscode-foreground)}
</style>
</head>
<body>

<div class="section">
    <div class="section-header">📄 Current File</div>
    ${currentFile ? `<div class="current-file" title="${currentFile}">${currentFile}</div>` : ''}
    ${statsHtml}
    <div class="action-row">
        <button class="btn primary" id="btn-summary">Summary</button>
        <button class="btn" id="btn-clear">Clear</button>
    </div>
</div>

<div class="section">
    <div class="section-header">🎨 Highlights</div>
    <div class="toggle-row" id="toggle-highlights">
        <span class="toggle-label">Show Highlights</span>
        <span class="badge">${highlightsVisible ? 'ON' : 'OFF'}</span>
    </div>
    <div class="theme-grid">${themeButtons}</div>
</div>

<div class="section">
    <div class="section-header">
        🔍 Audited Files
        <span class="section-header-count">${files.length}</span>
    </div>
    ${fileRows}
</div>

<script>
const vscode = acquireVsCodeApi();
document.getElementById('btn-summary')
    .addEventListener('click', () => vscode.postMessage({ command: 'showSummary' }));
document.getElementById('btn-clear')
    .addEventListener('click', () => vscode.postMessage({ command: 'clearCurrent' }));
document.getElementById('toggle-highlights')
    .addEventListener('click', () => vscode.postMessage({ command: 'toggleHighlights' }));
document.querySelectorAll('.theme-btn').forEach(btn =>
    btn.addEventListener('click', () => vscode.postMessage({ command: 'setTheme', theme: btn.dataset.theme }))
);
document.querySelectorAll('.btn-remove').forEach(btn =>
    btn.addEventListener('click', () => vscode.postMessage({ command: 'removeAudit', path: btn.dataset.path }))
);
</script>
</body>
</html>`;
    }
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('Magenta');
    context.subscriptions.push(outputChannel);

    // Restore persisted UI preferences
    highlightsVisible = context.globalState.get<boolean>('magenta.highlightsVisible', true);
    currentTheme      = context.globalState.get<ThemeName>('magenta.theme', 'default');
    createDecorationTypes(currentTheme);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'aiDetector.showSummary';
    context.subscriptions.push(statusBarItem);

    // ── Managers (require a workspace folder) ─────────────────────────────
    let persistence:  PersistenceManager  | null = null;
    let auditedFiles: AuditedFileManager  | null = null;
    let auditLogger:  AuditLogger         | null = null;
    const sessionId = generateSessionId();

    const getPersistence = (): PersistenceManager | null => persistence;
    const getAuditedFiles = (): AuditedFileManager | null => auditedFiles;

    function initManagers(wsRoot: string): void {
        persistence  = new PersistenceManager(wsRoot);
        persistence.ensureGitignore(context); // async, non-blocking
        const magentaDir = path.join(wsRoot, '.magenta');
        auditedFiles = new AuditedFileManager(magentaDir);
        auditLogger  = new AuditLogger(magentaDir);
    }

    if (vscode.workspace.workspaceFolders?.length) {
        initManagers(vscode.workspace.workspaceFolders[0].uri.fsPath);
    }

    // ── File decoration emitter ────────────────────────────────────────────
    const fileDecorationEmitter = new vscode.EventEmitter<vscode.Uri>();
    context.subscriptions.push(fileDecorationEmitter);

    // ── Sidebar provider ──────────────────────────────────────────────────
    const sidebar = new MagentaSidebarProvider(context.extensionUri, {
        getAuditedFiles: () => auditedFiles?.getAll() ?? [],
        onRemoveAudit: rel => {
            if (!auditedFiles) { return; }
            auditedFiles.removeFile(rel);
            const wsRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (wsRoot) {
                fileDecorationEmitter.fire(vscode.Uri.file(path.join(wsRoot, rel)));
            }
            vscode.commands.executeCommand('setContext', 'magenta.fileIsAudited', false);
            sidebar.refresh();
        },
        onToggleHighlights: () => {
            highlightsVisible = !highlightsVisible;
            context.globalState.update('magenta.highlightsVisible', highlightsVisible);
            reapplyAllEditors();
            sidebar.refresh();
        },
        onSetTheme: theme => {
            currentTheme = theme;
            context.globalState.update('magenta.theme', theme);
            createDecorationTypes(theme);
            reapplyAllEditors();
            sidebar.refresh();
        },
        onClearCurrent: () => vscode.commands.executeCommand('aiDetector.clearHighlights'),
        onShowSummary:  () => vscode.commands.executeCommand('aiDetector.showSummary'),
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MagentaSidebarProvider.viewType, sidebar, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    // ── Paste intercept ────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('magenta.pasteIntercept', async () => {
        pasteInterceptTimestamp = Date.now();
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    }));

    // ── Snippet intercept ──────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('magenta.snippetIntercept', async () => {
        snippetInterceptTimestamp = Date.now();
        await vscode.commands.executeCommand('editor.action.insertSnippet');
    }));

    // ── Text change listener ───────────────────────────────────────────────
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async event => {
        const editor = vscode.window.visibleTextEditors.find(e => e.document === event.document);
        if (!editor) { return; }

        const now = Date.now();
        let clipboard = '';
        try { clipboard = await vscode.env.clipboard.readText(); } catch { /* ignore */ }

        const key = getDocKey(event.document);
        let lines = trackedLines.get(key) ?? [];

        for (const change of event.contentChanges) {
            lines = adjustLinesForEdit(lines, change);
            if (!change.text || change.text.trim().length === 0) { continue; }

            const kind = classify(change.text, now, clipboard);
            if (!kind) { continue; }

            const insertedLineTexts = change.text.split('\n');
            const startLine = change.range.start.line;
            const ts = Date.now();

            for (let i = 0; i < insertedLineTexts.length; i++) {
                if (insertedLineTexts[i].trim().length === 0) { continue; }
                lines.push({ line: startLine + i, type: kind, timestamp: ts });
            }
        }

        // Deduplicate — keep latest entry per line number
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
        persistence?.saveFile(key, lines, event.document);
    }));

    // ── Editor focus change ────────────────────────────────────────────────
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor) { statusBarItem.hide(); return; }

        const key = getDocKey(editor.document);

        // Restore from disk if no in-memory state exists
        if (!trackedLines.has(key) && persistence) {
            const saved = persistence.loadFile(key);
            if (saved && saved.length > 0) { trackedLines.set(key, saved); }
        }

        reapplyDecorations(editor);
        sidebar.refresh();

        if (auditedFiles) {
            const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
            vscode.commands.executeCommand('setContext', 'magenta.fileIsAudited', auditedFiles.isAudited(rel));
        }
    }));

    // ── Command: clear highlights ──────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('aiDetector.clearHighlights', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        const key = getDocKey(editor.document);
        trackedLines.set(key, []);
        reapplyDecorations(editor);
        persistence?.clearFile(key);
        sidebar.refresh();
    }));

    // ── Command: toggle highlights ─────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('magenta.toggleHighlights', () => {
        highlightsVisible = !highlightsVisible;
        context.globalState.update('magenta.highlightsVisible', highlightsVisible);
        reapplyAllEditors();
        sidebar.refresh();
    }));

    // ── Command: set theme (command palette) ───────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('magenta.setTheme', async () => {
        const options: Array<{ label: string; description: string; theme: ThemeName }> = [
            { label: '● Default',       description: 'Subtle tints with emoji markers', theme: 'default' },
            { label: '◉ Subtle',        description: 'Minimal — dot markers only',      theme: 'subtle' },
            { label: '◈ High Contrast', description: 'Bold colors for accessibility',   theme: 'high-contrast' },
            { label: '○ Off',           description: 'Disable all decorations',         theme: 'off' },
        ];

        const pick = await vscode.window.showQuickPick(
            options.map(o => ({ ...o, picked: o.theme === currentTheme })),
            { title: 'Magenta: Choose Highlight Theme', placeHolder: `Current: ${currentTheme}` }
        );

        if (!pick) { return; }

        currentTheme = pick.theme;
        context.globalState.update('magenta.theme', currentTheme);
        createDecorationTypes(currentTheme);
        reapplyAllEditors();
        sidebar.refresh();
    }));

    // ── Command: summary ──────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('aiDetector.showSummary', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showInformationMessage('Magenta: no active editor.'); return; }

        const key   = getDocKey(editor.document);
        const lines = trackedLines.get(key) ?? [];
        const { aiPct, pastePct, totalLines, aiLines, pasteLines } = computePercents(editor.document, lines);

        const msg = aiLines === 0 && pasteLines === 0
            ? '✅ No AI-generated or pasted code detected in this file.'
            : `🤖 AI: ${aiPct}% (${aiLines}/${totalLines} lines)\n📋 Pasted: ${pastePct}% (${pasteLines}/${totalLines} lines)`;

        vscode.window.showInformationMessage(msg, 'Clear Highlights', 'Change Theme').then(choice => {
            if (choice === 'Clear Highlights') { vscode.commands.executeCommand('aiDetector.clearHighlights'); }
            else if (choice === 'Change Theme') { vscode.commands.executeCommand('magenta.setTheme'); }
        });
    }));

    // ── Command: add audit (explorer right-click) ─────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('magenta.addAudit', (uri: vscode.Uri) => {
        if (!auditedFiles) { return; }
        const rel = vscode.workspace.asRelativePath(uri, false);
        auditedFiles.addFile(rel);
        fileDecorationEmitter.fire(uri);
        vscode.commands.executeCommand('setContext', 'magenta.fileIsAudited', true);
        sidebar.refresh();
    }));

    // ── Command: remove audit (explorer right-click) ──────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('magenta.removeAudit', (uri: vscode.Uri) => {
        if (!auditedFiles) { return; }
        const rel = vscode.workspace.asRelativePath(uri, false);
        auditedFiles.removeFile(rel);
        fileDecorationEmitter.fire(uri);
        vscode.commands.executeCommand('setContext', 'magenta.fileIsAudited', false);
        sidebar.refresh();
    }));

    // ── File decoration provider (audit badge) ────────────────────────────
    context.subscriptions.push(vscode.window.registerFileDecorationProvider({
        onDidChangeFileDecorations: fileDecorationEmitter.event,
        provideFileDecoration(uri: vscode.Uri) {
            if (!auditedFiles) { return undefined; }
            const rel = vscode.workspace.asRelativePath(uri, false);
            if (!auditedFiles.isAudited(rel)) { return undefined; }
            return {
                badge: 'A',
                tooltip: 'Magenta: file access is being audited',
                color: new vscode.ThemeColor('magenta.auditedFile'),
            };
        },
    }));

    // ── Audit: onDidOpenTextDocument ──────────────────────────────────────
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
        if (!auditedFiles || !auditLogger) { return; }
        if (doc.uri.scheme !== 'file') { return; }

        const rel = vscode.workspace.asRelativePath(doc.uri, false);
        if (!auditedFiles.isAudited(rel)) { return; }

        const openedVisibly = vscode.window.visibleTextEditors
            .some(e => e.document.uri.toString() === doc.uri.toString());

        auditLogger.log({
            event: 'file-opened',
            file: rel,
            timestamp: new Date().toISOString(),
            sessionId,
            source: openedVisibly ? 'user' : 'programmatic',
            activeEditor: vscode.window.activeTextEditor
                ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri, false)
                : null,
            openEditors: vscode.workspace.textDocuments
                .filter(d => d.uri.scheme === 'file')
                .map(d => vscode.workspace.asRelativePath(d.uri, false)),
        });

        if (!openedVisibly) {
            vscode.window.setStatusBarMessage(`Magenta: audited file accessed programmatically — ${rel}`, 4000);
        }
    }));

    // ── Audit: context key on editor change ───────────────────────────────
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor || !auditedFiles) { return; }
        const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
        vscode.commands.executeCommand('setContext', 'magenta.fileIsAudited', auditedFiles.isAudited(rel));
    }));

    // ── File rename handler ────────────────────────────────────────────────
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(event => {
        for (const { oldUri, newUri } of event.files) {
            const oldKey = oldUri.toString();
            const newKey = newUri.toString();
            const existing = trackedLines.get(oldKey);
            if (existing) { trackedLines.set(newKey, existing); trackedLines.delete(oldKey); }
            persistence?.renameFile(oldKey, newKey);

            const oldRel = vscode.workspace.asRelativePath(oldUri, false);
            const newRel = vscode.workspace.asRelativePath(newUri, false);
            auditedFiles?.renameFile(oldRel, newRel);
        }
    }));

    // ── File delete handler ────────────────────────────────────────────────
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(event => {
        for (const uri of event.files) {
            const key = uri.toString();
            trackedLines.delete(key);
            persistence?.deleteFile(key);
            auditedFiles?.removeFile(vscode.workspace.asRelativePath(uri, false));
        }
    }));

    // ── Workspace folder change ────────────────────────────────────────────
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (!persistence && vscode.workspace.workspaceFolders?.length) {
            initManagers(vscode.workspace.workspaceFolders[0].uri.fsPath);
        }
    }));

    // ── Restore state for active editor on activation ─────────────────────
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const key = getDocKey(activeEditor.document);
        if (!trackedLines.has(key)) {
            const saved = getPersistence()?.loadFile(key);
            if (saved && saved.length > 0) { trackedLines.set(key, saved); }
        }
        reapplyDecorations(activeEditor);

        const rel = vscode.workspace.asRelativePath(activeEditor.document.uri, false);
        vscode.commands.executeCommand('setContext', 'magenta.fileIsAudited', getAuditedFiles()?.isAudited(rel) ?? false);
    }
}

export function deactivate(): void {
    trackedLines.clear();
}
