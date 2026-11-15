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

**Which window takes a file.** The answer folder is shared by every window, so every window's watcher sees every file. The prompt queue takes one only for a sending stage of its own that runs on Copilot and waits for an answer (it has an `expectedRequestId`): the file is that request's (`<expectedRequestId>_answer.json`), or this window's own window-named file (`<sessionId[0..8]>_<machineId[0..8]>_answer.json`, written when a prompt names no request id) whose content `requestId` is the expected one. Any other file is ignored unread, with one log line; a window-named file's request id is read from its content, never from its name. Only a taken answer fires `onAnswerReceived` (the reminder system cancels its reminders on it). The rule is `answerFileClaim` / `ownsAnswerFile` in [queueStep4Utils.ts](../src/utils/queueStep4Utils.ts); the manager applies it in `onAnswerFileChanged`, on the watcher and the polling path alike.

## Paths

The answer files are written directly into the Copilot answer folder: `copilot.answerFolder` in `tom_vscode_extension.json` (workspace-relative), default `_ai/answers/copilot/`. The prompt queue, the chat panel, a script's send to Copilot and the `${copilotAnswerFile}` / `${copilotAnswerFolder}` placeholders all use it; the Status Page's **Copilot answers** section shows it (**Copilot Answer Folder**, the default when unset) and sets it. A script's send (`sendToChatVce` with `target: 'copilot'`, `services/copilotRoundTrip.ts`) has no folder of its own: each send gets a `${requestId}` and passes it and its file, `<requestId>_answer.json` (`getCopilotAnswerFile` in variableResolver.ts), to the Copilot Queue Wrapper as `${requestId}` / `${copilotAnswerFile}`, then waits for exactly that file (up to two minutes, polling every two seconds). The per-window Markdown logs (`copilot-answer.md`, `copilot-prompts.md`) go into a window-id subfolder of the same folder (of `_ai/copilot/` when `copilot.answerFolder` is not set).

## Guidance

- Keep the payload schema backward-compatible — external automations (and the prompt queue's `request_id` matcher) depend on it.
- Preserve `responseValues` object semantics for downstream templates.
- When changing watcher behavior, update [../doc/copilot_chat_tools.md](../doc/copilot_chat_tools.md).
- When adding new payload fields, update [../doc/file_and_prompt_placeholders.md](../doc/file_and_prompt_placeholders.md) if the field becomes exposed as a placeholder.
