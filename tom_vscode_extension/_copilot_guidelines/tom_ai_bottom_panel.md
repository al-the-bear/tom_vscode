# TOM AI Bottom Panel (`@CHAT`)

## View identity

- container: `tomAi-chat-panel`
- view: `tomAi.chatPanel`
- display name: `@CHAT`
- handler: `src/handlers/chatPanel-handler.ts`

## Current subpanels

Accordion layout with five chat subpanels (see [tom_ai_chat.md](tom_ai_chat.md)):

1. **Anthropic** — direct Anthropic SDK or Agent SDK per selected profile.
2. **Tom AI Chat** — Anthropic handler with a tuned tool surface.
3. **AI Conversation** — multi-turn chat via Anthropic SDK or `vscode.lm`. Not queue-compatible.
4. **Copilot** — VS Code Copilot via answer-file mechanism.
5. **Local LLM** — Ollama-compatible HTTP backend.

## Responsibilities

- central prompt entry points across transports,
- template/profile management (per subpanel),
- Copilot answer-file monitoring,
- session history + memory + live-trail buttons (Anthropic),
- chat/tool context utilities (document picker, chat-variable expansion),
- prompt queue side panel for queue-compatible subpanels.

## Notes

- Guidelines and Documentation sections live in `@WS` ([wsPanel](tom_status_page.md) — `tomAi.wsPanel`).
- Session / Workspace todos live in the `@TOM` sidebar tree views, not in `@CHAT`.
- Layout primitives: accordion (one-section-focus with pin), tab rotation (collapsed sections as vertical tabs). See [bottom_panel_accordion.md](bottom_panel_accordion.md) and [tab_navigation.md](tab_navigation.md).
