# Configuration files

The files the extension reads its configuration from, where each lives, and which code owns it.

## 1. The files

| File | Purpose |
| --- | --- |
| `src/config/tom_vscode_extension.schema.json` | JSON Schema for the on-disk extension config. |
| `src/utils/sendToChatConfig.ts` | TypeScript shape of `SendToChatConfig`. Must stay in sync with the JSON schema. |
| `.tom/tom_vscode_extension.json` (the root's) | The active config consumed at runtime, read and written at the root of the Tom workspace: the window's layout (`utils/workspaceLayout.ts`) takes the first folder as the workspace folder and the nearest folder above it with `.tom/tom_root.yaml` as the root; `tomAi.layout.*` settings override it. |
| User-global overlay | Fallback-compatible overlay — a user-scope copy of the same shape that supplies defaults when the workspace omits a key. |
| `_ai/quests/{questId}/config/extension_config.{questId}.yaml` (per-quest, machine-INDEPENDENT) | Consolidated per-quest settings that are the same on every host: telegram settings (`allowedUserIds`, `defaultChatId`, `pollIntervalMs`) MCP server settings (`mcpServer`: `enabled`, `host`, `basePort`, `apiKeyEnv`, `allowWriteWithoutAuth`, `toolsEnabled`, `enabledTools`) and the quest default of the aspect guidelines (`aspectGuidelines`: aspect → choice, a list, or `remove`). Section document — each subsystem owns one top-level key. |
| `_ai/quests/{questId}/config/extension_config.{hostSlug}.{questId}.yaml` (per-quest, machine-SPECIFIC) | Consolidated per-host settings: quest-refresh counters (`questRefresh`), telegram machine bits (`enabled`, `autostart`, `botTokenEnv`), and CLI/MCP server autostart (`cliServer.autostart`, `mcpServer.autostart`). Host-scoped because the `_ai` clone is symlinked/synced across the fleet. |

Both `config/extension_config.*.yaml` files are owned by `src/managers/extensionConfigStore.ts` (section-scoped reads/writes preserve unknown sections). A single-purpose `telegram.{questId}.json` or `quest-refresh.yaml` of an older build is migrated into them on first access (`migrateQuestExtensionConfig`). Telegram is read/written by every consumer via `src/handlers/telegram-config.ts`; the resolved `botToken` is never persisted (derived from `botTokenEnv` at load). One constraint: **one `getUpdates` consumer per bot token** — a second poller on the same token gets HTTP 409, so each quest needs its own bot.

## 2. Changing the shape

When changing the configuration shape, update **both** the schema and `sendToChatConfig.ts` in lockstep so the editor UI and the runtime types stay aligned.
