# Telegram Integration

The extension can drive a Telegram bot as a **remote control + notification
channel** for a workspace window: run prompts from your phone, watch the live
conversation stream, manage the prompt queue, and receive start/turn/end
notifications. Everything is **per quest** — each workspace/quest resolves its
own bot token, and the window that polls a bot is the one that acts on its
commands.

> **One receiver per bot token.** Telegram allows exactly one `getUpdates`
> consumer per bot token. If a second consumer starts on the same token — another
> window, or a second poller in the same window — Telegram returns HTTP 409 to
> the superseded caller and the two pollers thrash. **Give each quest its own
> bot.** Sending is unaffected; only receiving (polling) is exclusive. See
> §6.

## 1. Setup

1. **Create a bot** with [@BotFather](https://t.me/BotFather) and copy its token.
2. **Export the token as an environment variable** (never store the raw token in
   config — see §3). For example `export TOM_TELEGRAM_BOT_TOKEN=123456:ABC...`,
   then point config at it with `botTokenEnv: TOM_TELEGRAM_BOT_TOKEN`.
3. **Find your numeric Telegram user ID** (e.g. via [@userinfobot](https://t.me/userinfobot))
   and add it to `allowedUserIds`. Only whitelisted users are answered; every
   other sender is rejected before any command runs.
4. **Set `defaultChatId`** to the chat that should receive notifications (your own
   user ID works for a direct chat).
5. **Enable + start** from the **Status Page → Telegram** section (§5), or the
   `tomAi.telegram.toggle` command (§4).

Use **Test Connection** (Status Page button or `tomAi.telegram.testConnection`)
to verify the token + chat ID before enabling polling.

## 2. Commands

Send these as chat messages to the bot. Unknown text is treated as free-form
`info` (added to the active conversation). Commands are only honoured for users
in `allowedUserIds`.

### Conversation control

| Command | Aliases | Effect |
| --- | --- | --- |
| `/stop`, `stop` | | Stop the poller for this window. |
| `/halt` | `/pause` | Halt the active AI Conversation (pausable). |
| `/continue` | `/resume` | Resume a halted conversation. |
| `/status`, `status` | | Report workspace / polling status. |
| `/info <text>` | `/add <text>` | Add input to the active conversation. |

### Live conversation (Anthropic panel)

Registered only while a live-conversation forwarder is active for the window.

| Command | Effect |
| --- | --- |
| `send_prompt <text>` | Run `<text>` as a prompt in **this quest's** Anthropic chat panel. |
| `chat_start` / `chat_stop` | Master switch: turn live forwarding on / off. |
| `chat_listen` / `chat_silent` | While forwarding: stream every update, or only the final answer + footer. |
| `chat_status` | Show currently-running prompt(s), elapsed time, and the listening / forwarding mode. |
| `cancel_chat` | Cancel the running direct prompt. |
| `cancel_queue` | Cancel the running queue prompt. |

### Prompt queue

| Command | Effect |
| --- | --- |
| `queue_prompt [count] [next] <text>` | Append `<text>` to the prompt queue; optional repeat `count` and `next` to jump the line. |
| `queue_list` | List pending / sending entries. |
| `queue_delete <index>` | Remove the entry at the 1-based index. |
| `queue_pause` | Toggle the queue between paused and running. |

### Workspace / tooling

| Command | Aliases | Effect |
| --- | --- | --- |
| `help [command]` | | List commands, or detail one. |
| `ls [path]` / `cd <path>` / `cwd` | | Navigate / show the working directory. |
| `project [name]` | | List projects, or switch to one. |
| `dart analyze [project]` | | Run `dart analyze` and report. |
| `problems` | | Summarise the VS Code Problems pane. |
| `todos` | | Show `TODO` / `FIXME` items from Problems. |
| `bk [args...]` | `buildkit` | Run BuildKit. |
| `tk [args...]` | `testkit` | Run Testkit. |
| `bridge <restart\|stop\|mode>` | | Control the Dart scripting bridge. |
| `cli-integration <start\|stop> [port]` | | Control the CLI integration server. |

Commands are parsed in `telegram-cmd-parser.ts`, dispatched by the
`TelegramCommandRegistry` in `telegram-cmd-handlers.ts`, and rendered by
`telegram-cmd-response.ts`. Multi-line messages are parsed per line.

## 3. Per-quest configuration

Telegram settings live in the consolidated per-quest extension config, split
across two files by whether the value is the same on every host. Both are owned
by `src/managers/extensionConfigStore.ts` and read/written through
`src/handlers/telegram-config.ts` — **not** the central
`.tom/tom_vscode_extension.json`.

### Machine-INDEPENDENT — `_ai/quests/{quest}/extension_config.{quest}.yaml`

Shared across all hosts (the `_ai` clone is synced fleet-wide), under a
top-level `telegram` section:

```yaml
# extension_config.{quest}.yaml  (machine-independent)
telegram:
  allowedUserIds: [123456789]     # whitelisted Telegram user IDs (required)
  defaultChatId: 123456789        # chat that receives notifications
  pollIntervalMs: 2000            # getUpdates interval (default 2000)
  notifyOnStart: true             # notify when a conversation starts
  notifyOnTurn: true              # notify per turn
  notifyOnEnd: true               # notify when a conversation ends
  includeResponseText: true       # include response text in notifications
  maxResponseChars: 500           # cap on included response chars
```

### Machine-SPECIFIC — `_ai/quests/{quest}/extension_config.{hostSlug}.{quest}.yaml`

Per host, because each machine runs its own bot token and enable/autostart state
(the fields in `MACHINE_TELEGRAM_FIELDS`):

```yaml
# extension_config.{hostSlug}.{quest}.yaml  (machine-specific)
telegram:
  enabled: false                  # whether Telegram is active on this host
  autostart: false                # auto-start polling on activation
  botTokenEnv: TOM_TELEGRAM_BOT_TOKEN  # env var name holding the bot token
```

### Bot token — never persisted

The raw `botToken` is **never written to disk**. It is resolved at load time from
`process.env[botTokenEnv]` (`telegram-config.ts`); if the env var is unset the
channel stays disabled. This keeps secrets out of the git-tracked `_ai` clone.

### Migration fallbacks

When the per-quest sections are absent, config is sourced (once) from, in order:
the merged per-quest sections (authoritative when present) → the shared
`tom_vscode_extension.json` `aiConversation.telegram` block → the legacy
`telegram.{hostSlug}.{quest}.yaml` file (auto-migrated on first save). The legacy
single-purpose `telegram.{questId}.json` is superseded.

## 4. VS Code commands

| Command ID | Title | Effect |
| --- | --- | --- |
| `tomAi.telegram.toggle` | Telegram: Start/Stop | Start or stop polling for the window. |
| `tomAi.telegram.testConnection` | Telegram: Test Connection | Send a test message to verify the token + chat ID. |
| `tomAi.telegram.configure` | Telegram: Configure | Interactive wizard for token env, user IDs, chat ID, and enabled state. |

## 5. Status Page section

The **Status Page → Telegram** section surfaces the same settings as a form:
`enabled`, `botTokenEnv`, `defaultChatId`, `allowedUserIds` (comma-separated),
`pollIntervalMs`, `notifyOnStart` / `notifyOnTurn` / `notifyOnEnd`, and the
per-host `autostart` checkbox. It pre-populates from the effective merged config
and writes back via `updateTelegramSettings`. Two buttons wire to the VS Code
commands above: **Test Connection** and **Configure**. Machine-specific fields
(`enabled`, `autostart`, `botTokenEnv`) are written to the host file; everything
else to the quest file.

## 6. Live-conversation forwarding

`TelegramLiveConversationForwarder` (`telegramTrailForwarder.ts`) bridges the
window's live trail to Telegram. It subscribes to every live-trail event for the
window's quest (filtered via `questMatches`, so only this quest's events are
forwarded) and streams the prompt restatement, tool calls, assistant text, and a
terminal footer, tracking each running prompt (direct vs queue) with elapsed
time.

Two independent switches control it:

- **Master switch** — `chat_start` / `chat_stop` (`setForwarding`). When
  forwarding is off, nothing is sent, not even the final answer.
- **Verbosity** — `chat_listen` / `chat_silent` (`setListening`). *Listening*
  (default) forwards every coalesced update; *silent* suppresses the intermediate
  tool-call / streamed-text updates and sends only the final answer + footer when
  the turn ends.

`chat_status` reports the current running prompt(s) plus both switch states.

### Notifications (`TelegramNotifier`)

Separate from the live stream, `TelegramNotifier` (`telegram-notifier.ts`) sends
lifecycle notifications gated by the `notifyOn*` config flags:
`notifyStart` (goal + profile), `notifyTurn` (turn N/max + prompt/response
previews, capped by `maxResponseChars`), `notifyEnd` (turns, goal-reached,
reason), plus `notifyHalted` / `notifyContinued`. Outbound text uses
`sendMessage` / `sendMessageWithDetails`.

## 7. One receiver per bot token — how it's enforced

The 409 constraint is enforced in-process by `PollClaimRegistry`
(`src/utils/telegramPollClaim.ts`). `TelegramChannel` holds one shared static
instance; `startListening` calls `tryClaim(token)` and only starts a poll loop
when it wins the claim — a second channel resolving the same token gets `false`
and defers (send-only), releasing on `stopListening`. This is why the send-only
**AI Conversation** channel does not poll: it registers a command **sink**
(`setTelegramConversationSink` in `aiConversation-handler.ts`) so the single
standalone poller routes conversation-control commands to it. Across separate
windows/hosts the registry cannot help — the token is genuinely shared — so give
each quest its own bot.

## 8. Formatting

Outbound messages are sent as Telegram **MarkdownV2** with an automatic plain-text
fallback: `TelegramChannel.sendMessage` tries MarkdownV2 first and, on a format
error, retries the message stripped to plain text. `telegram-markdown.ts`
provides `escapeMarkdownV2` (escapes the MarkdownV2 reserved set), `toTelegramMarkdownV2`
(converts standard Markdown), and `stripMarkdown` (the plaintext fallback).

## Source map

| Concern | File |
| --- | --- |
| Low-level Bot API transport + poll claim | `src/handlers/chat/telegram-channel.ts` |
| Poll-claim arbiter (409 avoidance) | `src/utils/telegramPollClaim.ts` |
| Command parsing / dispatch / rendering | `src/handlers/telegram-cmd-parser.ts`, `telegram-cmd-handlers.ts`, `telegram-cmd-response.ts` |
| Standalone poller + command registry | `src/handlers/telegram-commands.ts` |
| `send_prompt` / queue command helpers | `src/utils/telegramSendPrompt.ts`, `src/utils/telegramQueueCommands.ts` |
| Notifications | `src/handlers/telegram-notifier.ts` |
| Live-conversation forwarder | `src/handlers/telegramTrailForwarder.ts` |
| Per-quest config read/write | `src/handlers/telegram-config.ts`, `src/managers/extensionConfigStore.ts` |
| MarkdownV2 formatting | `src/handlers/telegram-markdown.ts` |
