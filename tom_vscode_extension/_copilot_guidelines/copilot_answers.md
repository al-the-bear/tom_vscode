# Copilot Answers and Answer File Flow

## Purpose

Document the answer-file workflow used by Unified Notepad Copilot integration.

## File model

Answer artifacts use JSON payloads containing:

- `requestId`
- `generatedMarkdown`
- optional `comments`
- optional `references`
- optional `requestedAttachments`
- optional `responseValues`

## Runtime behavior

Unified Notepad watches answer files (`*_answer.json`) and updates slot-specific UI state.

Capabilities:

- answer-ready highlighting,
- requestId-to-slot mapping,
- optional append/export to markdown trails,
- extracted values fed into chat response variables.

## Paths

Answer location resolves from configured Copilot answer path (workspace-relative by default) with window-specific subfolders.

## Guidance

- Keep payload schema backward-compatible.
- Preserve `responseValues` object semantics for downstream templates.
- When changing watcher behavior, update user docs in `doc/copilot_chat_tools.md`.
