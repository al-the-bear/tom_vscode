# Copilot Chat and Ask-AI Tools

This document describes the currently implemented AI tooling exposed by the extension.

## Scope

The extension integrates three AI paths:

- Copilot Chat send/templating flows.
- Tom AI Chat tools (`registerTomAiChatTools`).
- Local LLM and escalation helpers (including Ask-AI style queries).

## Copilot Chat Workflows

Main commands:

- `dartscript.sendToChat`
- `dartscript.sendToChatStandard`
- `dartscript.sendToChatAdvanced`
- `dartscript.reloadSendToChatConfig`

Unified Notepad (`@CHAT`) also supports Copilot prompt slots, template selection, answer-file polling, and response value extraction.

## Ask-AI / Escalation Tooling

Ask-AI capabilities are now documented here and no longer in a separate guideline file.

Runtime initialization:

- `initializeToolDescriptions()`
- `initializeEscalationTools()`
- `registerTomAiChatTools(context)`

These tools are available to Tom AI Chat workflows and include model-assisted escalation helpers for broader-context queries.

## Tom AI Chat Tools

Tom AI Chat command surface:

- `dartscript.startTomAIChat`
- `dartscript.sendToTomAIChat`
- `dartscript.interruptTomAIChat`

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

Copilot interactions in Unified Notepad can persist prompt/answer trails under `_ai/trail` and answer artifacts under configured Copilot answer folders.

Key behavior:

- answer detection for `*_answer.json`,
- slot-aware answer highlighting,
- optional value extraction into chat response values.

## Related Docs

- `user_guide.md`
- `quick_reference.md`
- `../_copilot_guidelines/tom_ai_chat.md`
- `../_copilot_guidelines/copilot_answers.md`
