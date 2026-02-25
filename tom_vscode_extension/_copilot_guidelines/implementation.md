# Implementation Notes

This file describes the current implementation structure for maintainers.

## Code layout

- `src/extension.ts` — activation/deactivation and top-level registration.
- `src/handlers/` — command/webview handlers.
- `src/managers/` — persistent and in-memory managers/stores.
- `src/tools/` — Tom AI chat tool registration and execution plumbing.
- `src/utils/` — shared helpers (workspace paths, etc.).

## Webview implementation pattern

Use handler classes implementing `WebviewViewProvider`.

Recommended pattern:

1. keep message routing small and explicit,
2. isolate complex section logic in helper methods,
3. reuse shared UI component builders (`accordionPanel`, `tabPanel`).

## Configuration model

Configuration is split between:

- VS Code settings (lightweight toggles/paths),
- workspace files under `_ai/` (templates, notes, queues, trails).

## Current panel section ownership

`@CHAT` (Unified Notepad):

- Session Todo
- Workspace Todo
- Local LLM
- AI Conversation
- Copilot
- Tom AI Chat

`@WS` (T3):

- Guidelines
- Documentation
- Logs
- Settings
- Issues
- Tests
- Quest TODO

## Coding constraints

- Keep command IDs stable once published.
- Prefer backward-compatible config changes.
- Avoid hard dependency on optional external packages at activation.
