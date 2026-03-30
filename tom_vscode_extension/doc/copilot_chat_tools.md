# Copilot Chat and Ask-AI Tools

This document describes the currently implemented AI tooling exposed by the extension.

## Scope

The extension integrates three AI paths:

- Copilot Chat send/templating flows.
- Tom AI Chat tools (`registerTomAiChatTools`).
- Local LLM and escalation helpers (including Ask-AI style queries).

## Copilot Chat Workflows

Main commands:

- `tomAi.sendToCopilot`
- `tomAi.sendToCopilot.standard`
- `tomAi.sendToCopilot.template`
- `tomAi.reloadConfig`

Unified Notepad (`@CHAT`) also supports Copilot prompt slots, template selection, answer-file polling, and response value extraction.

### CHAT Action Bar

The Copilot section of `@CHAT` includes an action bar with:

- **R** (24px text input): Repeat count — how many times to send the prompt
- **W** (24px text input): Answer wait minutes — 0 for classic answer-file detection, >0 for time-based auto-advance
- **Template picker**: Select from configured prompt templates
- **Queue button**: Add to queue with current R/W settings

## Prompt Queue Integration

Copilot prompts flow through the `PromptQueueManager` for sequenced dispatch:

- **File-per-entry storage**: Each queued prompt is a separate YAML file (`q_<id>.yaml`)
- **RequestId-based answer detection**: Unique IDs embedded in prompts match answer files
- **Repeat support**: `repeatCount`, `repeatPrefix`, `repeatSuffix` with placeholders `${repeatNumber}`, `${repeatIndex}`, `${repeatCount}`
- **Answer wait minutes**: Time-based auto-advance when `answerWaitMinutes > 0`
- **Automation**: Auto-send, auto-start, auto-pause, auto-continue settings
- **Watchdog**: 60s health check + 30s polling fallback for answer detection

See [user_guide.md](user_guide.md#4-prompt-queue) for full queue documentation.

## Timed Requests

The timer engine fires prompts on schedule:

- **Interval mode**: Every N minutes with optional `sendMaximum` limit
- **Scheduled mode**: At specific `HH:MM` times with optional date restriction
- **Global schedule slots**: Day-of-week and time-of-day restrictions
- Entries enqueue through `PromptQueueManager` (never send directly)

See [user_guide.md](user_guide.md#5-timed-requests) for full timer documentation.

## Ask-AI / Escalation Tooling

Ask-AI capabilities are now documented here and no longer in a separate guideline file.

Runtime initialization:

- `initializeToolDescriptions()`
- `initializeEscalationTools()`
- `registerTomAiChatTools(context)`

These tools are available to Tom AI Chat workflows and include model-assisted escalation helpers for broader-context queries.

## Tom AI Chat Tools

Tom AI Chat command surface:

- `tomAi.tomAiChat.start`
- `tomAi.tomAiChat.send`
- `tomAi.tomAiChat.interrupt`

Tool categories include:

- workspace file and text search,
- file and notebook editing,
- command/terminal execution,
- diagnostics and task flow helpers,
- optional integrations (GitHub PR, Flutter, Dart tooling daemon, web fetch/search).

## Chat Variables and Context

Chat variables are registered via `contributes.chatVariables` and resolved through `registerChatVariableResolvers(context)`.

Current variables:

- `quest`
- `role`
- `activeProjects`
- `todo`
- `workspaceName`

## Trails and Answer Files

Copilot interactions in `@CHAT` panel can persist prompt/answer trails under `_ai/trail` and answer artifacts under configured Copilot answer folders.

Key behavior:

- answer detection for `*_answer.json` using requestId matching,
- fallback polling every 30s if file watcher misses events,
- slot-aware answer highlighting,
- optional value extraction into chat response values,
- window state tracking for multi-window status panel.

## Output Channels

Dedicated output channels provide structured logging:

- **Tom Prompt Queue**: Queue state changes, send events, answer detection, watchdog health
- **Tom Timed Requests**: Timer ticks, fire decisions, schedule evaluation, entry lifecycle

Both channels include ISO timestamps and can be enabled/disabled at runtime.

## Related Docs

- [user_guide.md](user_guide.md)
- [quick_reference.md](quick_reference.md)
- [../_copilot_guidelines/tom_ai_chat.md](../_copilot_guidelines/tom_ai_chat.md)
- [../_copilot_guidelines/copilot_answers.md](../_copilot_guidelines/copilot_answers.md)
- [../_copilot_guidelines/architecture.md](../_copilot_guidelines/architecture.md)
