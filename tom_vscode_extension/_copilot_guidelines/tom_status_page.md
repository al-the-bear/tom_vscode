# Tom Status Page

Runtime status + configuration dashboard. Source: [statusPage-handler.ts](../src/handlers/statusPage-handler.ts).

## Command

- `tomAi.statusPage` — bound to `Ctrl+Shift+8`.

## Purpose

Single-page view for runtime visibility into extension state, configuration highlights, and operational checks. Also serves as the configuration UI for chat subsystems (profiles, templates, memory, tool set, history settings).

## Content areas

- **Bridge / runtime status** — bridge profile, PID, last message, connection state.
- **Chat subsystems readiness** — per-subsystem (Anthropic, Tom AI Chat, AI Conversation, Copilot, Local LLM) config snapshot with transport + history-mode indicators.
- **Anthropic profiles** — curated profiles (3 models × 3 modes) with picker; per-profile memory / tool-set / approval mode overrides.
- **History + memory settings** — compaction mode, memory injection toggles, two-tier memory paths.
- **Configured paths** — workspace root, quest folder, trail folder, Copilot answer folder.
- **Quick actions** — restart bridge, toggle debug logging, open config file, clear session, etc.

## Embedded in `@WS`

The `@WS` panel's **Settings** section embeds a summary view of the status page so the user doesn't have to context-switch.

## Maintenance

When adding a major subsystem:

1. Expose a summarised status block in `statusPage-handler.ts`.
2. Include an actionable troubleshooting link or command (restart / reload / open log).
3. Keep output concise and human-readable — the page is dense; don't grow it without pruning old sections.
4. When deprecating settings, update the handler to hide the removed block and update [../doc/user_guide.md](../doc/user_guide.md) + [../doc/quick_reference.md](../doc/quick_reference.md).
