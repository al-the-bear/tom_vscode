# TOM AI Bottom Panel (`@CHAT`)

## View identity

- container: `tomAi-chat-panel`
- view: `tomAi.chatPanel`
- display name: `@CHAT`
- handler: `src/handlers/chatPanel-handler.ts`

## Current subpanels

Accordion layout with two chat subpanels (see [anthropic_chat.md](anthropic_chat.md)) and the Logs section:

1. **Copilot** — VS Code Copilot via answer-file mechanism.
2. **ANTHROPIC/LLM** (section id `anthropic`) — direct Anthropic SDK, Agent SDK, VS Code LM or a Local LLM configuration, per selected profile.
3. **Logs** (section id `logs`) — one Anthropic session's files, with the session switch and the session's actions behind it. The viewer is the quest-logs engine (`questLogs-handler.ts`, `media/questLogs/`): the host passes `getQuestLogsHtmlFragment()` and `getQuestLogsClientConfig(['logs'])` as `__INIT__.questLogs`, `media/chatPanel/main.js` sets the viewer's config globals from it, and `index.html` loads `media/questLogs/main.js` and `style.css` after the panel's own files; `qlog*` messages go to `handleQuestLogsMessage`.

## Responsibilities

- central prompt entry points across transports,
- template/profile management (per subpanel),
- Copilot answer-file monitoring,
- the session's files, history, memory and live trail (the Logs section),
- chat/tool context utilities (document picker, chat-variable expansion),
- prompt queue side panel for queue-compatible subpanels.

## Notes

- Guidelines and Documentation sections live in `@WS` ([wsPanel](tom_status_page.md) — `tomAi.wsPanel`).
- Session todos live in the `@TOM` sidebar, workspace todos in `@TOM WS`, not in `@CHAT`.
- Layout primitives: accordion (one-section-focus with pin), tab rotation (collapsed sections as vertical tabs). See [bottom_panel_accordion.md](bottom_panel_accordion.md) and [tab_navigation.md](tab_navigation.md).
