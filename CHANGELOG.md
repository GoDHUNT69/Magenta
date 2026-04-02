# Changelog

All notable changes to the Magenta extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - 2025-04-XX

### Added
- Real-time AI-generated code detection with inline highlighting (🤖 glyph + pink background)
- Paste detection via clipboard matching and keyboard intercept (📋 glyph + amber background)
- Live status bar percentage — AI% and Paste% updated on every edit
- Summary dialog with per-file breakdown and "Clear Highlights" action
- Drift correction — tracked line numbers shift correctly after insertions and deletions
- Snippet intercept to prevent false positives from Emmet, VS Code built-ins, and extension snippets
- Persistence via `.magenta/` workspace folder — flags survive VS Code restarts
- Project-wide aggregate statistics in `.magenta/index.json`
- `.gitignore` prompt on first activation
- File access audit — right-click any file to start tracking opens
- Programmatic vs. user open detection with JSONL access log
- Purple "A" badge on audited files in the explorer
- Explorer context menu integration with dynamic toggle
- Four color themes: Magenta, Noir, Contrast+, Cyber
- Overview ruler integration for at-a-glance flagged region view
- Configurable settings: `flagSnippetsAsAI`, `pasteWindowMs`, `snippetWindowMs`
- File rename and delete handlers for persistence and audit cleanup
- Output channel for diagnostics (View → Output → Magenta)