# Restart / Debugging Flow (Backup)

Backup reference for extension runtime troubleshooting. Use when a reload alone doesn't fix things.

## Fast path

1. `@T: Restart Bridge` — bridge subprocess recovery.
2. `@T: Extension Status Page` — verify bridge profile, PID, last message, chat transports.
3. `@T: Toggle Bridge Debug Logging` — stream wire traffic to "Tom Dartbridge Log".
4. Reload window (`Developer: Reload Window`) if command metadata looks stale.

## If issue persists

- Verify command registration matches between `package.json` and `src/handlers/*` / `src/extension.ts`.
- Inspect the "Extension Host" and "Tom Debug" output channels for activation errors.
- For Anthropic-path issues, inspect `_ai/trail/anthropic/<quest>/` for the most recent `*_payload_*.payload.md` / `*_answer_*.answer.json` to see what reached / came back from the model.
- For Agent SDK SDK-managed continuity: inspect `_ai/quests/<quest>/history/default.session.json` — delete it if corrupted; a fresh session will be created next turn.
- Reinstall the extension package (see [reinstall_extension.md](reinstall_extension.md)) and reload.

## Panel-specific checks

- **`@CHAT`** — focus the panel, confirm all five subpanels render, confirm profile picker populates on the Anthropic subpanel, confirm the "Open Live Trail" button opens the MD Browser in live mode.
- **`@WS`** — focus, verify embedded issue / test / quest-todo rendering and link navigation.
- **`@TOM` sidebar** — note and todo views refresh correctly after external file edits (file watcher is active).
- **Markdown Browser** — test link navigation, back/forward, file-watcher auto-reload, live-mode follow-tail.

## Full recovery

1. Close all VS Code windows for the workspace.
2. Run `dart pub get` in the bridge package if Dart dependencies changed.
3. Reinstall the extension (`npx tsc --noEmit` → package → install).
4. Reopen the workspace.
