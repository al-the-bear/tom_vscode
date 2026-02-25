# Tom AI Chat

## Command surface

- `dartscript.startTomAIChat`
- `dartscript.sendToTomAIChat`
- `dartscript.interruptTomAIChat`

## Tool registration

Tom AI tools are registered during activation via:

- `initializeToolDescriptions()`
- `initializeEscalationTools()`
- `registerTomAiChatTools(context)`

## Context model

Chat variable resolvers provide values for:

- `quest`
- `role`
- `activeProjects`
- `todo`
- `workspaceName`

## Ask-AI integration

Ask-AI style escalation is treated as part of the Tom AI/Copilot tool ecosystem and documented in `../doc/copilot_chat_tools.md`.

## Operational guidance

- Keep tool schema and naming stable.
- Register new tools via central tool registration modules.
- Ensure tool docs are updated with behavior changes.
