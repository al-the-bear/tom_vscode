# Explorer Notes and Todo Views

## Contributed explorer views

- VS CODE NOTES (`dartscript.tomNotepad`)
- QUEST NOTES (`dartscript.questNotesView`)
- QUEST TODOS (`dartscript.questTodosView`)
- SESSION TODOS (`dartscript.sessionTodosView`)
- WORKSPACE NOTES (`dartscript.workspaceNotepad`)
- WORKSPACE TODOS (`dartscript.workspaceTodosView`)

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
