# Magenta Feature Doc

## Product summary

Magenta is a VS Code extension focused on lightweight auditability for AI-assisted development. It gives developers and teams a way to see where pasted or likely AI-generated code entered a file and to track access to selected files during a VS Code session.

## Goals

- Make AI and pasted code visible at the point of editing
- Preserve a simple audit trail in the workspace
- Keep the UX lightweight enough to leave on during normal coding
- Support policy and compliance conversations with concrete artifacts

## Feature set

### 1. AI-generated code detection

Magenta classifies inserted text as AI-generated when it passes a heuristic check. The current heuristic favors larger, highly structured insertions with consistent formatting and high character density.

User value:

- surfaces suspicious generated blocks immediately
- gives a rough signal without requiring an external service

### 2. Paste detection

Magenta intercepts paste shortcuts and also compares inserted text against clipboard contents. When the content is identified as pasted, the affected lines are marked separately from AI-generated lines.

User value:

- distinguishes direct paste activity from heuristic AI detection
- supports workflow review and attribution discussions

### 3. Inline editor decorations

Flagged lines are rendered with whole-line decorations, overview-ruler markers, and theme-specific trailing labels. Users can switch between decoration themes or turn decorations off while keeping tracking enabled.

User value:

- keeps flagged content easy to spot
- allows users to tune the signal strength to their preference

### 4. Live file percentages

The status bar and sidebar show approximate percentages of AI and pasted lines for the active file, calculated against non-empty lines with overlap protection.

User value:

- gives an immediate sense of how much of a file was tool-assisted
- makes progress visible without opening a separate report

### 5. Sidebar control surface

The Magenta sidebar acts as the main control panel. It shows active-file stats, exposes common actions, and lists currently audited files.

User value:

- centralizes high-frequency actions
- reduces command palette hopping

### 6. File access audit

Users can mark files for auditing from the Explorer. When an audited file is opened, Magenta records the event to `.magenta/access-log.jsonl` with contextual metadata including session id, active editor, and whether the open looked user-driven or programmatic.

User value:

- creates a simple local audit trail
- helps identify silent reads by tools or extensions

### 7. Persistent workspace metadata

Magenta stores line-level tracking and aggregate summaries in `.magenta/`, letting tracked state survive restarts and file renames.

User value:

- preserves context across sessions
- enables simple workspace-level reporting artifacts

## Commands and entry points

- `Magenta: Clear Highlights`
- `Magenta: Show Summary`
- `Magenta: Toggle Highlights`
- `Magenta: Choose Highlight Theme`
- `Magenta: Audit file access`
- `Magenta: Stop auditing file access`
- Explorer context menu actions for audit management
- Activity bar view at `magenta.sidebar`

## Settings

- `magenta.flagSnippetsAsAI`
- `magenta.pasteWindowMs`
- `magenta.snippetWindowMs`

## Limitations

- Detection is heuristic and can produce false positives or false negatives
- Existing code is not retroactively classified when a file is first opened
- File access auditing only covers opens visible through the VS Code extension host
- Multi-root workspaces currently initialize persistence from the first workspace folder

## Success criteria

- Developers can tell when large inserted blocks came from paste or likely generation
- Audit data is written locally and survives extension reloads
- Users can manage highlights and audited files without leaving the editor
