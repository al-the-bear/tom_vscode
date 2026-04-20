# Implementation Notes

Structural notes for maintainers. For the architectural "why", see [architecture.md](architecture.md).

## Code layout

```text
src/
  extension.ts       activation + top-level command registration
  config/            JSON Schema + project type definitions
  handlers/          command + webview providers (chat panel, ws panel, editors, bridge)
  managers/          volatile session state (queue, timer, reminders, chat vars, session todos)
  services/          persistence (trails, history, memory, tool trail, live trail)
  tools/             everything exposed to AI models (dispatchers + domain modules)
  utils/             config, paths, variable resolution, logging, webview helpers
```

Layer boundaries (handlers → managers/services → tools → utils) are enforced by convention. No `services/*` file imports from `handlers/*` or `tools/*`. See [architecture.md](architecture.md) for the full dependency map.

## Webview implementation pattern

Use handler classes implementing `WebviewViewProvider` or `CustomEditorProvider`.

Recommended pattern:

1. Keep message routing small and explicit (flat `switch(msg.type)`).
2. Isolate complex section logic in helper methods on the handler, not inside HTML builders.
3. Reuse shared UI component builders — [accordionPanel](../src/handlers/accordionPanel.ts), [tabPanel](../src/handlers/tabPanel.ts), queue entry component.
4. Persist webview state through `retainContextWhenHidden` + an explicit `getState()`/`setState()` pattern where cross-reload state matters.

## Anthropic + Agent SDK integration

- [anthropic-handler.ts](../src/handlers/anthropic-handler.ts) owns profiles, history, memory, trails, approval gate.
- [agent-sdk-transport.ts](../src/handlers/agent-sdk-transport.ts) is a thin translator — SDK query, MCP tool adapter, `canUseTool` bridge. It does **not** persist anything itself; raw trails, tool trail, live trail are driven by the handler and through callbacks from the stream loop.
- Session-id continuity (SDK-managed mode) uses a fixed-name file (`default.session.json`, per quest) with atomic writes. Early-save on init-message capture; safety-net save on stream completion. See [../doc/anthropic_handler.md](../doc/anthropic_handler.md).

## Configuration model

Split between:

- **VS Code settings** — lightweight toggles/paths (`tomAi.*` contributed in `package.json`).
- **Workspace files under `_ai/`** — templates, notes, queues, trails, memory, live trails, session history.
- **`sendToChatConfig.ts`** — central typed config shape for chat subpanels; validated against `config/tom_vscode_extension.schema.json`.

Any change to the config shape must update both `sendToChatConfig.ts` and the JSON schema in the same commit.

## Current panel section ownership

`@CHAT` (`tomAi.chatPanel`):

1. Anthropic
2. Tom AI Chat
3. AI Conversation
4. Copilot
5. Local LLM

`@WS` (`tomAi.wsPanel`):

- Guidelines
- Documentation
- Logs
- Settings
- Issues
- Tests
- Quest TODO

`@TOM` sidebar tree views:

- VS CODE NOTES / QUEST NOTES / WORKSPACE NOTES
- QUEST TODOS / SESSION TODOS / WORKSPACE TODOS
- TODO LOG (session-scoped)
- WINDOW STATUS

## Coding constraints

- Keep command IDs stable once published. Keybindings, queue entries, and external scripts reference them.
- Prefer backward-compatible config changes; when breaking, provide migration on load.
- Avoid hard dependency on optional external packages at activation. Use dynamic `import()` inside try/catch for optional features (`yaml-graph`, `claude-agent-sdk`).
- Run `npx tsc --noEmit` before committing; zero warnings in the Problems pane.
- Never skip git hooks, never `--amend` a commit after a hook failure.
