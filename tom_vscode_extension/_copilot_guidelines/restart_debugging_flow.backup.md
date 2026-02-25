# Restart/Debugging Flow (Backup)

Backup reference for extension runtime troubleshooting.

## Fast path

1. `DS: Restart Bridge`
2. `DS: Extension Status Page`
3. `DS: Toggle Bridge Debug Logging`
4. Reload window if necessary

## If issue persists

- verify command registration in `package.json`,
- verify handler registration in `src/extension.ts`,
- verify no activation errors in extension host output,
- reinstall extension package and reload.

## Panel-specific checks

- `@CHAT` focus and section rendering,
- `@WS` focus and embedded issue/test/quest-todo behavior,
- explorer note/todo view focus commands.
