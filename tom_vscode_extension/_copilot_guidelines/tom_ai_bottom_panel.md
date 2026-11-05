# TOM AI Bottom Panel (`@CHAT`)

## View identity

- container: `tomAi-chat-panel`
- view: `tomAi.chatPanel`
- display name: `@CHAT`
- handler: `src/handlers/chatPanel-handler.ts`

## Current subpanels

Accordion layout with two chat subpanels (see [anthropic_chat.md](anthropic_chat.md)):

1. **Anthropic** — direct Anthropic SDK, Agent SDK, VS Code LM or a Local LLM configuration, per selected profile.
2. **Copilot** — VS Code Copilot via answer-file mechanism.

## Responsibilities

- central prompt entry points across transports,
- template/profile management (per subpanel),
- Copilot answer-file monitoring,
- session history + memory + live-trail buttons (Anthropic),
- chat/tool context utilities (document picker, chat-variable expansion),
- prompt queue side panel for queue-compatible subpanels.

## Notes

- Guidelines and Documentation sections live in `@WS` ([wsPanel](tom_status_page.md) — `tomAi.wsPanel`).
- Session todos live in the `@TOM` sidebar, workspace todos in `@TOM WS`, not in `@CHAT`.
- Layout primitives: accordion (one-section-focus with pin), tab rotation (collapsed sections as vertical tabs). See [bottom_panel_accordion.md](bottom_panel_accordion.md) and [tab_navigation.md](tab_navigation.md).
