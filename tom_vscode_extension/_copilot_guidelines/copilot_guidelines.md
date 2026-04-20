# Copilot Coding Guidelines for this Extension

## Goals

- keep behavior aligned with registered commands and view IDs,
- prefer minimal, targeted edits,
- preserve message protocol compatibility in webviews,
- keep docs synchronized with implementation changes.

## Required checks for changes

- Typecheck TypeScript (`npx tsc --noEmit`) — zero errors and zero Problems-pane warnings before commit.
- Verify impacted command IDs still match `package.json` `contributes.commands`.
- Verify panel / view / custom-editor IDs still match registration (`tomAi.chatPanel`, `tomAi.wsPanel`, `tomAi.markdownBrowser`, `tomAi.yamlGraphEditor`, `tomAi.todoEditor`, `tomAi.trailViewer`).
- When changing `sendToChatConfig` shape, update `config/tom_vscode_extension.schema.json` in the same commit.

## Documentation sync rules

When changing command surfaces, panel sections, transports, or architecture:

1. Update [vscode_extension_overview.md](vscode_extension_overview.md) (flagship).
2. Update relevant focused guideline file(s) in `_copilot_guidelines/`.
3. Update [../doc/quick_reference.md](../doc/quick_reference.md) and [../doc/user_guide.md](../doc/user_guide.md) if user-visible behavior changed.
4. When touching trail, history, memory, or profile semantics, also update [../doc/anthropic_handler.md](../doc/anthropic_handler.md) and [../doc/chat_log_custom_editor.md](../doc/chat_log_custom_editor.md) if relevant.

## Message handling

- Use explicit `type`/`action` branches.
- Avoid introducing ambiguous message payloads.
- Keep payload schema backward-compatible where possible.

## Reliability

- Guard filesystem access.
- Fail soft for optional feature stacks.
- Keep activation resilient to partial dependency failures.
