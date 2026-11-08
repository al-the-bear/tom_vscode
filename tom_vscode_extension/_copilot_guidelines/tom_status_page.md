# Tom Status Page

Runtime status + configuration dashboard. Source: [statusPage-handler.ts](../src/handlers/statusPage-handler.ts).

## Command

- `tomAi.statusPage` — bound to `Ctrl+Shift+8`.

## Purpose

Single-page view for runtime visibility into extension state, configuration highlights, and operational checks. Also serves as the configuration UI for chat subsystems (profiles, templates, memory, tool set, history settings).

## Content areas

- **Extension build** — the build this window runs and the one installed (`buildSectionHtml`, from `src/services/buildStatusService.ts`); when a newer one is installed, a warning and a **Reload window** button (action `reloadWindow`).
- **Usage and cost** — today's and the since-reset totals of this window's sends, per model: sends, tokens, cache reads and writes, cost (`usageSectionHtml`, `src/utils/usageSection.ts`, from the ledger in `src/services/usageLedgerService.ts`). Costs come from `anthropic.modelPrices` (direct, counted round by round, so a failed send shows what it used) or the Agent SDK's own report; an unpriced model or a Local LLM shows "no price". **Reset** (action `resetUsage`) starts the since-reset totals again.
- **Bridge / runtime status** — bridge profile, PID, last message, connection state.
- **Chat subsystems readiness** — per-subsystem (Anthropic, Copilot) config snapshot with transport + history-mode indicators; the Local LLM configurations are in the **LLM Configurations** section.
- **Anthropic profiles** — curated profiles (3 models × 3 modes) with picker; per-profile memory / tool-set / approval mode overrides.
- **History + memory settings** — compaction mode, memory injection toggles, two-tier memory paths. History Compaction has two dropdowns, **Compaction model** and **Memory extraction model**, each listing every Anthropic configuration (with its transport) and every Local LLM configuration (`compactionTargetChoices`, `src/utils/compactionTarget.ts`); saving writes `compaction.compactionModel` / `memoryExtractionModel` and drops the older `llmProvider` / `llmConfigId`. The prompt queue editor shows the same two pickers above the queue (`compactionPickerState` for both, `setCompactionModel` for its write); a save in either refreshes the other (`refreshQueueEditorState`, `refreshStatusPage`).
- **Assist prompts** — one row per use (Grill me, Explain in detail, Explain a decision, Grill me at a decision, Finish review round, Out of budget): a dropdown of the Assist Prompts templates with *(default: …)*, ✏️ / ➕ / 🗑️ beside it (actions `editAssistPrompt`, `addAssistPrompt`, `deleteAssistPrompt`, each with the row's `use` and the chosen `itemId`; ✏️ without a choice opens the use's default template), and **Save Assist Prompts** (`updateAssistPrompts`, writes `assistPrompts.selected`). Resolution and placeholders: `src/utils/assistPrompts.ts`.
- **Configured paths** — workspace root, quest folder, trail folder, Copilot answer folder.
- **Quick actions** — restart bridge, toggle debug logging, open config file, clear session, etc.

## MCP Server cards

The standalone MCP server (see [../doc/mcp_server.md](../doc/mcp_server.md)) is configured and controlled by **two sibling cards** rendered by [mcpServerCard.ts](../src/utils/mcpServerCard.ts) under one shared `data-mcp-card` wrapper; message handling is in [statusPage-handler.ts](../src/handlers/statusPage-handler.ts). The shared wrapper lets the `saveMcpServer` gather reach every `data-mcp-field` / `data-mcp-tool` control regardless of which card it lives in.

- **MCP Server** (control card, always open) — the live runtime status badge (running + bound port, or stopped), the **Start / Stop / Restart** buttons, and the `enabled` / `autoStart` checkboxes. Always open so the lifecycle controls are directly reachable without expanding an accordion.
- **MCP Server Configuration** (accordion, default collapsed, `data-collapse="mcpConfig"`) — the remaining `mcpServer.*` fields (`host`, `basePort`, `apiKeyEnv`, `allowWriteWithoutAuth`, `toolsEnabled`, and the tool picker for `enabledTools`) plus the **Save** button. The accordion **closes on save**: the `saveMcpServer` post step in `listeners.js` collapses `sp-mcpConfig-content` client-side, and the post-save panel refresh (main.js) preserves the collapsed state.
- **Save** — the `saveMcpServer` action gathers both cards' controls and persists the `mcpServer` block (including `enabled` / `autoStart` from the control card); saving reconciles the running server (disabled ⇒ stop, running ⇒ restart onto the new settings).
- **Start / Stop / Restart** — these buttons route through the generic `[data-status-action]` dispatcher to the `startMcpServer` / `stopMcpServer` / `restartMcpServer` handler cases, which call the `tomAi.mcpServer.start` / `.stop` / `.restart` commands (no per-action `listeners.js` branch — the no-payload actions ride the existing dispatcher). The controller's `onChange → refreshStatusPage` push updates the status line.

## Embedded in `@WS`

The `@WS` panel's **Settings** section embeds a summary view of the status page so the user doesn't have to context-switch.

## Maintenance

When adding a major subsystem:

1. Expose a summarised status block in `statusPage-handler.ts`.
2. Include an actionable troubleshooting link or command (restart / reload / open log).
3. Keep output concise and human-readable — the page is dense; don't grow it without pruning old sections.
4. When deprecating settings, update the handler to hide the removed block and update [../doc/user_guide.md](../doc/user_guide.md) + [../doc/quick_reference.md](../doc/quick_reference.md).
