# Copilot Answers and Answer File Flow

## Purpose

Documents the answer-file workflow used by the **Copilot** subpanel in `@CHAT`. GitHub Copilot doesn't surface its responses programmatically, so the subpanel writes prompts to disk and watches for a matching answer file produced by the user (or an external automation).

## File model

Answer artifacts are JSON payloads containing:

- `requestId` — unique id that matches the outgoing prompt.
- `generatedMarkdown` — the response body.
- optional `comments`
- optional `references`
- optional `requestedAttachments`
- optional `responseValues` — extracted key/value pairs fed back into chat variable resolvers.

Naming: `*_answer.json` in the configured Copilot answer folder (resolved by `getCopilotChatAnswerFolderAbsolute()` in [sendToChatConfig.ts](../src/utils/sendToChatConfig.ts)).

## Runtime behavior

The chat panel watches answer files and updates slot-specific UI state for the Copilot subpanel:

- Answer-ready highlighting on the slot that sent the prompt.
- RequestId-to-slot mapping (up to 4 slots).
- Append / export to summary trail (`*.prompts.md` / `*.answers.md` under the subsystem trail folder).
- Extracted `responseValues` feed into chat response variables.

A polling fallback (every 30 seconds, tied to the queue watchdog) catches missed file-watcher events.

## Paths

The answer files are written directly into the Copilot answer folder: `copilot.answerFolder` in `tom_vscode_extension.json` (workspace-relative), default `_ai/answers/copilot/`. The prompt queue, the chat panel and the `${copilotAnswerFile}` / `${copilotAnswerFolder}` placeholders all use it. The per-window Markdown logs (`copilot-answer.md`, `copilot-prompts.md`) go into a window-id subfolder of the same folder (of `_ai/copilot/` when `copilot.answerFolder` is not set).

## Guidance

- Keep the payload schema backward-compatible — external automations (and the prompt queue's `request_id` matcher) depend on it.
- Preserve `responseValues` object semantics for downstream templates.
- When changing watcher behavior, update [../doc/copilot_chat_tools.md](../doc/copilot_chat_tools.md).
- When adding new payload fields, update [../doc/file_and_prompt_placeholders.md](../doc/file_and_prompt_placeholders.md) if the field becomes exposed as a placeholder.
