<p align="center">
  <img src="images/icon.png" alt="Magenta Logo" width="96" />
</p>

<h1 align="center">Magenta</h1>

<p align="center">
  Track AI-generated and pasted code inline, right inside VS Code.
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-extension-purple.svg" />
</p>

---

Magenta watches your editor as you work and flags inserted content it identifies as AI-generated or pasted. Flagged lines are highlighted inline and tracked across reloads — giving you visibility into your codebase's composition without interrupting your flow.

> **Note:** Magenta is heuristic-based and does not claim authorship with certainty. It's a tool for visibility and auditing, not a substitute for review or source attribution.

---

## Features

### Inline highlighting

Magenta intercepts text changes and classifies inserted content as:

- **`ai`** — matched Magenta's structural heuristics for generated code (size, indentation consistency, trailing spaces, character density)
- **`paste`** — matched clipboard or paste-intercept signals

Flagged lines are highlighted in the editor and the overview ruler so they stay visible without taking over the UI.

### Live status bar

The status bar shows the active file's estimated content mix at a glance:

```
$(robot) 34% AI  $(clippy) 12% Paste
```

When the file is clean, Magenta shows a simple clean state instead.

### Sidebar panel

The Magenta activity bar view gives you quick access to:

- AI and paste percentages for the current file
- A one-click **Summary** action
- **Clear** highlights for the active file
- **Toggle** highlight visibility
- **Theme** selector for highlight styles
- A list of audited files

### File access auditing

Right-click any file in the Explorer to start or stop auditing it:

- **Magenta: Audit file access** — begins logging open events
- **Magenta: Stop auditing file access** — removes the file from the audit list

Audited files are marked with an `A` badge in the Explorer. Open events are written to `.magenta/access-log.jsonl` and labeled `user` or `programmatic` depending on whether the file opened visibly in an editor tab.

### Persistent metadata

Tracked line metadata is stored under `.magenta/` and survives reloads and restarts. An aggregate index keeps workspace-level summaries up to date.

---

## Commands

| Command | Description |
|---|---|
| `Magenta: Clear Highlights` | Remove tracked flags from the active file |
| `Magenta: Show Summary` | Show AI and paste counts for the active file |
| `Magenta: Toggle Highlights` | Show or hide decorations |
| `Magenta: Choose Highlight Theme` | Switch highlight presentation |
| `Magenta: Audit file access` | Start auditing a file (Explorer context menu) |
| `Magenta: Stop auditing file access` | Remove a file from the audit list |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `magenta.flagSnippetsAsAI` | `false` | Treat snippet insertions as AI-generated when they fall inside the snippet detection window |
| `magenta.pasteWindowMs` | `150` | Time window (ms) after paste interception used to classify content as paste |
| `magenta.snippetWindowMs` | `150` | Time window (ms) after snippet interception used to suppress or classify snippet content |

---

## How detection works

Magenta combines several signals to classify inserted content:

- **Explicit paste interception** via keybindings
- **Clipboard matching** for inserted content
- **Generated-code heuristics** based on block size, indentation consistency, trailing spaces, and character density
- **Line-drift correction** so tracked ranges move accurately with subsequent edits

No model calls are made. Everything runs locally and offline.

---

## Workspace files

Magenta may create the following files in your workspace:

```
.magenta/
├── files/**/*.json       # Per-file tracked line metadata
├── index.json            # Aggregate workspace statistics
├── audited.json          # Audited file list
├── access-log.jsonl      # Audit open events
└── config.json           # Custom ignore patterns (when configured)
```

Add `.magenta/` to your `.gitignore` if you don't want to commit this data.

---

## Development

```bash
npm install
npm run compile
```

| Script | Purpose |
|---|---|
| `npm run watch` | Development builds with file watching |
| `npm run lint` | ESLint |
| `npm run check-types` | TypeScript validation |
| `npm test` | VS Code test runner |

Press `F5` in VS Code to launch an Extension Development Host.

---

## Documentation

- [`docs/FEATURES.md`](docs/FEATURES.md) — detailed feature documentation
- [`docs/TECHNICAL.md`](docs/TECHNICAL.md) — architecture and internals

---

## License

[MIT](LICENSE)
