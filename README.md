# 🟣 Magenta — AI & Paste Code Auditor for VS Code

> **Know exactly how much of your codebase was written by you.**

Magenta is a lightweight VS Code extension that detects AI-generated and pasted code in real time, highlights it inline, and keeps a running percentage of how much of each file came from a human versus a tool.

Built for developers who care about code ownership, compliance, and audit trails — especially with EU AI Act enforcement approaching and organizations tightening policies around AI-assisted code.

---

## What Magenta Does

### 🎨 Subtle Inline Highlighting

Flagged lines get a barely-there background wash and a glyph so you can see them without visual friction:

| Type | Indicator | Glyph |
|------|-----------|-------|
| AI-generated | Soft pink background (7% opacity) | 🤖 |
| Pasted code | Soft amber background (6% opacity) | 📋 |

Both types also mark the overview ruler (the thin strip on the right edge of the editor) — pink for AI, amber for paste — so you can spot flagged regions at a glance without scrolling.

### 📊 Live Status Bar Percentage

The status bar updates on every edit:

```
🤖 34% AI   📋 12% Paste
```

Percentages are calculated against non-blank lines. When no flagged content exists, the status bar reads `✓ Magenta: 0% AI`.

### 🔍 File Access Audit

Right-click any file in the explorer → **Magenta: Audit file access** to start tracking when and how it is opened. Every open event is logged to `.magenta/access-log.jsonl` with a `source` field:

- **`user`** — you opened the file yourself (it appeared in a visible editor tab)
- **`programmatic`** — another extension or process opened it silently

Programmatic opens trigger a brief status bar notification. This is the start of the compliance story — you can see exactly when an AI agent read a sensitive file during a session.

Audited files display a purple **A** badge in the explorer.

### 💾 Persistent Flag Storage

Highlights survive VS Code restarts. Flagged line data is stored in `.magenta/files/` as JSON, with a debounced write (500ms) to avoid hammering disk. An `index.json` provides project-wide aggregate statistics.

### 🎨 Four Color Themes

Magenta ships with four purpose-built dark themes:

- **Magenta** — the default, balanced purple palette
- **Magenta Noir** — deeper blacks, minimal color
- **Magenta Contrast+** — higher contrast for accessibility
- **Magenta Cyber** — neon-accented cyberpunk aesthetic

### ♻️ Drift Correction

Tracked line numbers shift correctly as you edit. Insert above a flagged block → it moves down. Delete inside → those flags are removed. No stale highlights.

---

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `Magenta: Show Summary` | Click status bar | Per-file AI% and Paste% breakdown |
| `Magenta: Clear Highlights` | `Ctrl+Shift+Alt+C` | Remove all flags from the active file |
| `Magenta: Audit file access` | Right-click in explorer | Start logging opens for a file |
| `Magenta: Stop auditing file access` | Right-click in explorer | Stop logging opens for a file |

---

## Getting Started

1. **Install** from the VS Code Marketplace (or `Extensions → Install from VSIX` for local builds)
2. **Open any file** and start coding
3. **Paste AI-generated code** — watch it get highlighted with 🤖 or 📋 and see the percentage update in the status bar

That's it. Magenta works immediately with zero configuration.

---

## Configuration

All settings are in VS Code's Settings UI under **Magenta**:

| Setting | Default | Description |
|---------|---------|-------------|
| `magenta.flagSnippetsAsAI` | `false` | When enabled, snippet expansions (Emmet, VS Code built-ins) are flagged as AI-generated |
| `magenta.pasteWindowMs` | `150` | Millisecond window after Ctrl+V during which change events are classified as paste |
| `magenta.snippetWindowMs` | `150` | Millisecond window after snippet intercept for suppression |

Changes take effect immediately — no reload needed.

---

## What Magenta Doesn't Do

Transparency builds trust. Here's what to know:

- **Not an oracle.** Detection is heuristic-based — it looks at structural signals (consistent indentation, no trailing spaces, high character density) and size gates (≥5 lines or ≥200 characters). Fast typists may trigger false positives; small AI completions may be missed.
- **No pre-existing code scanning.** Magenta is event-driven. Opening a file that already contains AI-generated code won't flag it retroactively.
- **VS Code layer only.** The file access audit tracks opens through VS Code's document model. It does not monitor shell-level reads (`cat`, `less`, direct file access by other processes`).
- **Single-file percentages.** Stats are per-file, not per-project or per-PR (project aggregate is available in `.magenta/index.json`).

---

## Known Limitations

- Heuristic accuracy varies by coding style — the detection layer is probabilistic, not ground-truth
- File access audit does not detect reads by external processes outside VS Code
- Multi-root workspaces use the first workspace folder for `.magenta/` storage

---

## Roadmap

- [ ] Shell monitoring pack — detect access outside VS Code
- [ ] Git integration — annotate diffs with AI/paste flags
- [ ] Per-project aggregate dashboard
- [ ] Configurable detection rules
- [ ] Export audit report (JSON / CSV)

---

## Building from Source

```bash
git clone https://github.com/YOUR_USERNAME/magenta.git
cd magenta
npm install
npm run compile
```

Press `F5` to launch the Extension Development Host.

### Build a VSIX

```bash
npm install -g @vscode/vsce
vsce package
```

Install via `Extensions → ··· → Install from VSIX`.

---

## Contributing

Pull requests welcome. Please open an issue before making large changes.

```bash
npm run compile   # type-check + lint + bundle
npm run watch     # incremental rebuild
```

---

## License

MIT © Magenta Contributors