# Magenta

Magenta is a VS Code extension for tracking AI-generated and pasted code as you work. It highlights suspicious edits inline, keeps per-file percentages in the status bar, and can audit when selected files are opened inside VS Code.

## Features

### Inline AI and paste highlighting

Magenta watches text changes in the editor and classifies inserted content as:

- `ai` when the content matches Magenta's structural heuristics for generated code
- `paste` when the content matches clipboard or paste-intercept signals

Flagged lines are highlighted in the editor and overview ruler so they stay visible without taking over the whole UI.

### Live file summary

The status bar shows the current file's estimated mix of flagged content:

```text
$(robot) 34% AI  $(clippy) 12% Paste
```

When the file is clean, Magenta shows a simple clean state instead.

### Sidebar controls

The Magenta activity bar view includes:

- current-file AI and paste percentages
- a quick summary action
- one-click clear for the active file
- highlight visibility toggle
- theme selection for highlight styles
- a list of audited files

### File access audit

You can right-click a file in the Explorer and choose:

- `Magenta: Audit file access`
- `Magenta: Stop auditing file access`

For audited files, Magenta writes open events to `.magenta/access-log.jsonl` and marks the file in the Explorer with an `A` badge. Events are labeled as either `user` or `programmatic` depending on whether the file opened visibly in an editor.

### Persistent metadata

Magenta stores tracked line metadata under `.magenta/` so highlights survive reloads and restarts. It also maintains an aggregate index for workspace-level summaries.

## Commands

| Command | Purpose |
| --- | --- |
| `Magenta: Clear Highlights` | Remove tracked flags from the active file |
| `Magenta: Show Summary` | Show AI and paste counts for the active file |
| `Magenta: Toggle Highlights` | Show or hide decorations |
| `Magenta: Choose Highlight Theme` | Switch highlight presentation |
| `Magenta: Audit file access` | Start auditing a file from the Explorer |
| `Magenta: Stop auditing file access` | Remove a file from the audit list |

## Settings

Magenta contributes these settings:

| Setting | Default | Description |
| --- | --- | --- |
| `magenta.flagSnippetsAsAI` | `false` | Treat snippet insertions as AI-generated when they fall inside the snippet detection window |
| `magenta.pasteWindowMs` | `150` | Time window after paste interception used to classify inserted content as paste |
| `magenta.snippetWindowMs` | `150` | Time window after snippet interception used to suppress or classify snippet content |

## How detection works

Magenta is heuristic-based. It does not claim authorship with certainty. The current implementation combines:

- explicit paste interception through keybindings
- clipboard matching for inserted content
- a generated-code heuristic based on size, indentation consistency, trailing spaces, and character density
- line-drift correction so tracked ranges move with edits

This makes Magenta useful for visibility and auditing, but not a substitute for policy, review, or source attribution.

## Workspace files

Magenta may create these files in the workspace:

- `.magenta/files/**/*.json` for per-file tracked lines
- `.magenta/index.json` for aggregate workspace statistics
- `.magenta/audited.json` for the audited file list
- `.magenta/access-log.jsonl` for audit events
- `.magenta/config.json` when custom ignore patterns are used

## Development

```bash
npm install
npm run compile
```

Useful scripts:

- `npm run watch` for development builds
- `npm run lint` for ESLint
- `npm run check-types` for TypeScript validation
- `npm test` for the VS Code test runner

Press `F5` in VS Code to launch an Extension Development Host.

## Documentation

Additional project documentation lives in [`docs/FEATURES.md`](docs/FEATURES.md) and [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

## License

MIT
