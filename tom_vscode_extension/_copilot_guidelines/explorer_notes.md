# Explorer Notes and Todo Views

## Contributed explorer views

- VS CODE NOTES (`tomAi.vscodeNotes`)
- QUEST NOTES (`tomAi.questNotes`)
- QUEST TODOS (`tomAi.questTodos`)
- SESSION TODOS (`tomAi.sessionTodos`)
- WORKSPACE NOTES (`tomAi.workspaceNotes`)
- WORKSPACE TODOS (`tomAi.workspaceTodos`)

## Purpose

Provide persistent, navigable workspace context directly in Explorer.

## Interaction with bottom panels

- `@CHAT` now includes quick Session/Workspace todo actions.
- `@WS` links to guidelines/documentation-related folders and embeds quest todo section.

## Maintenance

When changing view IDs or titles, update:

- `package.json` contributions,
- command handlers that focus/open these views,
- quick-reference/user docs.
