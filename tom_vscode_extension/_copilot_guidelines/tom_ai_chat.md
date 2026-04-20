# Tom AI Chat

The **Tom AI Chat** subpanel in `@CHAT` is one of five chat subsystems. It shares the Anthropic handler ([anthropic_handler.md](../doc/anthropic_handler.md)) with the dedicated Anthropic subpanel — same profile system, same transports, same trail surfaces — but exposes a narrower UI tuned for single-turn tool-rich workflows.

## Command surface

- `tomAi.tomAiChat.start`
- `tomAi.tomAiChat.send`
- `tomAi.tomAiChat.interrupt`

Source: [tomAiChat-handler.ts](../src/handlers/tomAiChat-handler.ts) routes user input through `AnthropicHandler`.

## Transports + history

Tom AI Chat reuses the Anthropic profile system (3 models × 3 modes = 9 profiles): Sonnet 4.6 / Opus 4.7 / Opus 4.6 each with Direct / Agent SDK T&S / Agent SDK SDK-managed variants. Profile selection lives in the subpanel's action bar.

- **Direct** — raw Anthropic SDK, history via `trim_and_summary`.
- **Agent SDK T&S** — Agent SDK with in-extension history compaction.
- **Agent SDK SDK-MM** — Agent SDK with SDK-managed session continuity (`_ai/quests/<quest>/history/default.session.json`).

## Tools exposed

Standard shared tools (file I/O, search, guidelines, memory, diagnostics, git, editor context) plus the **past-tool-access trio**:

- `tomAi_listPastToolCalls` — list prior tool calls with filtering (toolName, sinceRound, limit).
- `tomAi_searchPastToolResults` — regex across result bodies.
- `tomAi_readPastToolResult` — fetch full result by replay key (`t1`, `t2`, …).

All three back onto the in-memory tool trail ([tool-trail.ts](../src/services/tool-trail.ts)). Write tools (`tomAi_createFile`, `tomAi_editFile`, `tomAi_multiEditFile`, `tomAi_runCommand`, `tomAi_runVscodeCommand`, `tomAi_notifyUser`) go through the approval gate.

On the Agent SDK path, tools are exposed via an MCP server with the `mcp__tom-ai__<tool>` name prefix. Built-in Claude Code preset tools (Read/Write/Bash/Grep/…) are available when `useBuiltInTools: true`; their tool_use / tool_result blocks are mirrored into the raw + tool trails from the stream.

## Context model

Chat-variable resolvers provide values for:

- `${tomAi.quest}`, `${tomAi.role}`, `${tomAi.activeProjects}`, `${tomAi.todo}`, `${tomAi.workspaceName}`.

Memory placeholders (`${memory}`, `${memory-shared}`, `${memory-quest}`) are expanded for direct transport and skipped for Agent SDK (which pulls memory via `tomAi_memory_*` tools on demand).

## Operational guidance

- Keep tool schema and naming stable — breaking renames invalidate tool-trail history and past-tool-access keys.
- Register new tools in [src/tools/tool-executors.ts](../src/tools/tool-executors.ts) (dispatcher) and a domain-specific source file under [src/tools/](../src/tools/).
- Update [file_and_prompt_placeholders.md](../doc/file_and_prompt_placeholders.md) when adding new placeholders.
- For UI changes, edit [chatPanel-handler.ts](../src/handlers/chatPanel-handler.ts) + [tomAiChat-handler.ts](../src/handlers/tomAiChat-handler.ts) and update [copilot_chat_tools.md](../doc/copilot_chat_tools.md) when tool names or surface semantics change.
