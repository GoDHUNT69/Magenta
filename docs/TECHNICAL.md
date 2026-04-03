# Magenta Technical Doc

## Architecture overview

Magenta is implemented as a single VS Code extension entrypoint in `src/extension.ts`. The extension combines editor event listeners, local persistence, Explorer decorations, and a sidebar webview to provide its runtime behavior.

Primary runtime areas:

- change classification for inserted text
- decoration management for AI and paste markers
- persistence for per-file and aggregate metadata
- audited-file management and event logging
- sidebar rendering and command wiring

## Core data model

### Tracked lines

Magenta tracks flagged content as line-based records:

```ts
interface TrackedLine {
  line: number;
  type: 'ai' | 'paste';
  timestamp: number;
}
```

These records are stored in memory per document URI and serialized to `.magenta/files/...json`.

### Audit config and events

Audited files are stored in `.magenta/audited.json`. Open events are appended as JSON Lines records to `.magenta/access-log.jsonl`.

## Activation flow

The extension activates on `onStartupFinished`. During activation it:

1. restores persisted UI state such as theme and highlight visibility
2. creates decoration types for the active theme
3. creates the status bar item and output channel
4. initializes persistence and audit managers when a workspace is available
5. registers commands, listeners, the sidebar provider, and the file decoration provider
6. restores tracked state for the active editor when possible

## Detection pipeline

Inserted text is classified inside the `onDidChangeTextDocument` listener.

### Inputs

- current timestamp
- clipboard text
- recent paste intercept timestamp
- recent snippet intercept timestamp
- inserted text from each content change

### Classification order

1. Ignore empty or whitespace-only inserts.
2. If the insert falls inside `pasteWindowMs`, classify as `paste`.
3. If the insert falls inside `snippetWindowMs` and snippet flagging is disabled, ignore it.
4. If the insert matches clipboard contents, classify as `paste`.
5. If the insert passes `looksLikeGenerated`, classify as `ai`.
6. Otherwise do not track it.

### Generated-code heuristic

`looksLikeGenerated` currently requires:

- non-empty content
- minimum size gate of at least 5 lines or 200 characters
- enough positive signals among:
  - uniform indentation style
  - no trailing spaces
  - character density of at least `0.45`

This is intentionally lightweight and local-only.

## Line drift correction

Tracked flags are line-based, so edits can invalidate line positions. `adjustLinesForEdit` updates stored line numbers after every content change by:

- removing flags that fall inside the replaced range
- shifting flags below the edit by the net inserted/deleted line delta

After processing all changes, Magenta deduplicates line entries and keeps the latest timestamp per line.

## Decorations and UI state

Magenta maintains two `TextEditorDecorationType` instances:

- AI decoration type
- paste decoration type

Theme options:

- `default`
- `subtle`
- `high-contrast`
- `off`

The current theme and highlight visibility are stored in `context.globalState`. Reapplying decorations also updates the status bar summary for the active editor.

## Persistence layout

Workspace metadata is written under `.magenta/`.

- `.magenta/files/<relative-path>.json`
  Stores `FileMetadata` for a source file, including tracked flags and per-file percentages.
- `.magenta/index.json`
  Stores aggregate totals across persisted files.
- `.magenta/audited.json`
  Stores the audited file registry.
- `.magenta/access-log.jsonl`
  Appends one JSON object per audit event.
- `.magenta/config.json`
  Optional config file for ignore patterns used by persistence.

### Ignore behavior

`PersistenceManager` skips persistence for files matching ignore patterns. The default ignore list is:

- `node_modules/**`
- `dist/**`

If `.magenta/` is not already ignored, the extension can prompt the user to append it to `.gitignore`.

## Sidebar implementation

`MagentaSidebarProvider` renders a webview-based sidebar. It is not a React app; HTML is generated as a string and refreshed whenever the view needs to reflect current state.

The sidebar exposes callbacks for:

- removing audited files
- toggling highlight visibility
- switching themes
- clearing highlights for the current file
- opening the summary action

## Audit behavior

Audit events are generated from `workspace.onDidOpenTextDocument`. For a tracked file, Magenta determines whether the open appears visible in a current editor and writes:

- file path
- timestamp
- session id
- source classification: `user` or `programmatic`
- active editor path
- list of open editors

Programmatic opens also trigger a short status bar notification.

## File lifecycle handling

Magenta keeps persisted state aligned with workspace changes:

- on file rename, tracked state and persisted metadata are moved
- on file delete, tracked state and persisted metadata are removed
- audited file entries are renamed or removed alongside workspace file events

## Extension points from package.json

Magenta contributes:

- an activity bar container and sidebar webview
- commands
- explorer and editor title menu items
- keybindings for paste and snippet interception
- a custom color token for audited-file Explorer badges
- four bundled VS Code themes
- configuration settings under `magenta.*`

## Known technical constraints

- Most runtime logic currently lives in one large source file, which makes long-term maintenance harder
- Audit source classification is inferred from visible editors and is therefore approximate
- Persistence is line-based rather than range-based, which keeps the model simple but loses sub-line fidelity
- Multi-root workspaces currently initialize managers from the first workspace folder

## Recommended next engineering steps

- split `src/extension.ts` into focused modules
- add tests for classification, line drift correction, and persistence
- version persisted file formats more defensively for future migrations
- move sidebar HTML generation into a templated module for easier maintenance
