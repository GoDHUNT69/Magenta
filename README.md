# 🟣 Magenta — AI & Paste Code Auditor for VS Code

> **Know exactly how much of your codebase was written by you.**

Magenta is a lightweight VS Code extension that detects AI-generated and pasted code in real time, highlights it inline, and keeps a running percentage of how much of each file came from a human versus a tool. Built for developers who care about code ownership, compliance, and audit trails.

---

## Why Magenta?

AI coding tools are everywhere. Copilot, Cursor, ChatGPT, Gemini — they all inject code into your editor. That's useful. But it also creates a problem: **nobody knows what percentage of any given file was actually written by the developer**.

This matters for:

- **Code reviews** — reviewers deserve to know which lines were AI-generated
- **Compliance** — EU AI Act, internal IP policies, and open-source licenses increasingly require disclosure
- **Learning** — developers who want to actually understand what they ship
- **Interviews & assessments** — accurate representation of individual contribution

Magenta surfaces this information without getting in your way.

---

## Features

### 🎨 Subtle Inline Highlighting

Magenta highlights flagged lines directly in the editor using two very low-opacity full-line decorations:

| Type | Color | Gutter marker | Line glyph |
|------|-------|---------------|------------|
| AI-generated | Soft pink left border + 7% pink background | Pink dot in overview ruler | 🤖 italic glyph |
| Pasted code | Soft amber left border + 6% amber background | Amber dot in overview ruler | 📋 italic glyph |

The highlights are intentionally **almost invisible** — a faint left-border accent and a barely-there background wash. You can read, edit, and write over flagged lines without visual friction. The overview ruler (the thin column on the right edge of the editor) gives you a birds-eye view of where flagged regions live in the file.

### 📊 Live Percentage in the Status Bar

The status bar (bottom right) updates on every change:

```
🤖 34% AI   📋 12% Paste
```

- Percentages are rounded to whole numbers (no decimals)
- Denominator is **non-blank lines** in the current file — blank lines are excluded from the count
- Overlapping regions are de-duplicated by line number so a line is never double-counted
- Hovering the status bar item shows a tooltip breakdown

When no flagged content exists, it reads:

```
✓ Magenta: 0% AI
```

### 🧠 AI Detection Heuristics

Magenta does not require an API call or a language model to detect AI-generated code. It uses a set of local, zero-latency heuristics:

**Speed signals**
- Insert of 40+ characters arriving within 80 ms of the last keystroke → likely AI completion
- Insert of 150+ characters arriving within 50 ms → strong signal regardless of content

**Structural signals** (regex-based pattern matching)
- JSDoc comment blocks (`/** ... */`)
- `TODO:`, `FIXME:`, `NOTE:` markers (AI tools insert these constantly)
- `console.log()` calls with string literals
- Complete function signatures (`function foo(...) {`)
- Arrow functions with a body of 30+ characters
- TypeScript `interface` declarations
- `class` declarations with optional `extends`

Two or more pattern hits combined with a fast insert, or three or more pattern hits on their own, triggers a flag.

**Clipboard signals**
- If the inserted text exactly matches (or closely matches after trimming) the current clipboard contents, it is classified as a **paste** rather than AI, even if it would otherwise pass the AI heuristics.

> **Note:** Heuristics are probabilistic. Magenta will have false positives (fast paste that looks like AI) and false negatives (slow, deliberate AI completion). This is a detection layer, not a ground-truth oracle.

### 📋 Paste Detection

Any insert that matches the clipboard and is longer than 20 characters is flagged as a paste. This is separate from AI detection — you might paste your own code, in which case the amber highlight tells you so without implying it was AI-generated.

### 🔢 Summary Dialog

Click the status bar item or run `Magenta: Show Summary` from the Command Palette to open a dialog:

```
🤖 AI-generated: 34% (51 of 150 lines)
📋 Pasted: 12% (18 of 150 lines)
```

The dialog includes a **Clear Highlights** button to reset all flagged regions in the current file.

### 🗺️ Overview Ruler Integration

Every flagged region also marks the overview ruler on the right side of the editor — the minimap-like column that shows your position in the file. Pink dots for AI, amber dots for paste. At a glance you can see if a block of code at the bottom of a 400-line file was flagged without scrolling there.

### ♻️ Drift Correction

Tracked ranges shift correctly as you continue editing. If you insert lines above a flagged block, the block's line numbers update. If you delete lines inside a flagged block, the block is removed. The extension maintains range accuracy across arbitrarily long editing sessions without requiring a document re-scan.

---

## Commands

| Command | Keyboard shortcut | Description |
|---------|-------------------|-------------|
| `Magenta: Show Summary` | Click status bar item | Opens the per-file breakdown dialog |
| `Magenta: Clear All Highlights` | `Ctrl+Shift+Alt+C` / `Cmd+Shift+Alt+C` | Removes all decorations from the active file |

---

## Installation

### From source

```bash
git clone https://github.com/your-org/magenta.git
cd magenta
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

### Build a VSIX

```bash
npm install -g @vscode/vsce
vsce package
```

This produces a `.vsix` file you can install via:
```
Extensions → ··· → Install from VSIX
```

---

## Extension Settings

Magenta currently works out of the box with no configuration required. Future versions will expose settings for:

- Adjusting detection thresholds (speed window, minimum insert length)
- Disabling paste detection independently from AI detection
- Per-workspace opt-out
- Highlight opacity controls

---

## How Percentages Are Calculated

```
AI% = round( unique_AI_flagged_lines / total_non_blank_lines × 100 )
Paste% = round( unique_paste_flagged_lines / total_non_blank_lines × 100 )
```

- **Unique lines**: if the same line is covered by two overlapping flagged ranges, it is counted once.
- **Non-blank lines**: lines that contain at least one non-whitespace character. This avoids inflating the denominator with spacing.
- **Rounded to 0 decimals**: `Math.round()` — 34.5% becomes 35%, 34.4% becomes 34%.

---

## Architecture

```
extension.ts
│
├── Decoration types (module-level singletons)
│   ├── aiDecorationType     — pink, isWholeLine: true
│   └── pasteDecorationType  — amber, isWholeLine: true
│
├── State
│   ├── trackedRanges: Map<docUri, TrackedRange[]>
│   └── lastEditTime: number
│
├── Helpers
│   ├── toFullLineRange()       — expands insert range to full lines
│   ├── countDocumentLines()    — non-blank line count
│   ├── countTrackedLines()     — de-duped line count per type
│   ├── computePercents()       — derives aiPct, pastePct
│   ├── reapplyDecorations()    — sets decorations on editor
│   ├── updateStatusBar()       — renders percentage string
│   ├── looksLikeAiGenerated()  — heuristic detection
│   └── adjustRangesForEdit()   — drift correction on text changes
│
└── activate()
    ├── onDidChangeTextDocument  — main detection loop
    ├── onDidChangeActiveTextEditor — re-renders on focus switch
    ├── aiDetector.clearHighlights  — command
    └── aiDetector.showSummary      — command
```

---

## Known Limitations

- **Session-only**: Highlights do not persist across VS Code restarts. The extension tracks changes made during the current session only.
- **No pre-existing code scanning**: Opening a file that already contains AI-generated code will not flag it. Detection is event-driven, not document-scanning.
- **Heuristic accuracy**: Speed-based detection can misfire on very fast typists or autocomplete from non-AI sources (e.g. Emmet, snippets). Pattern-based detection misses AI code that doesn't match any of the defined patterns.
- **Single-file scope**: Percentages are per-file, not per-project or per-PR.

---

## Roadmap

- [ ] Persistent storage of flagged regions via workspace state
- [ ] Pre-scan on file open using static analysis
- [ ] Git integration — annotate diffs with AI/paste flags
- [ ] Per-project aggregate dashboard
- [ ] Configurable detection rules
- [ ] Export audit report (JSON / CSV)
- [ ] Team settings sync

---

## Contributing

Pull requests welcome. Please open an issue before making large changes.

```bash
npm run compile   # type-check + lint + bundle
npm run watch     # incremental rebuild
```

Lint is enforced via ESLint with the `curly` rule (always use braces). `tsc --noEmit` must pass cleanly.

---

## License

MIT © Magenta Contributors