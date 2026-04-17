# Anthropic Handler — Quick Start

The Anthropic handler exposes Claude models as a third LLM provider in the bottom panel, alongside the existing Local LLM (Ollama) and Tom AI Chat (VS Code LM API) handlers. Full design is in `_ai/quests/vscode_extension/anthropic_sdk_integration.md`.

## 1. Set the API key

The key is read from an environment variable at runtime — never written to the config file.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

The variable name is configurable via `anthropic.apiKeyEnvVar` in `tom_vscode_extension.json` (default `ANTHROPIC_API_KEY`). The 🔑 dot in the ANTHROPIC panel toolbar is green when the variable is populated, red otherwise.

## 2. Create a configuration

A configuration bundles a model id, token limits, history mode, tool set, and approval mode. Open the **Status Page → LLM Configurations** section, or edit `tom_vscode_extension.json` directly:

```json
"anthropic": {
  "configurations": [
    {
      "id": "default",
      "name": "Sonnet — balanced",
      "model": "claude-sonnet-4-6",
      "maxTokens": 8192,
      "temperature": 0.5,
      "memoryToolsEnabled": false,
      "historyMode": "last",
      "maxRounds": 20,
      "promptCachingEnabled": false,
      "isDefault": true
    }
  ]
}
```

The model dropdown in the panel is populated live from `anthropic.models.list()` — there is no hardcoded fallback list. If the API is unreachable, the dropdown is empty and Send is disabled.

## 2b. Choosing a transport

Every configuration runs over one of two backends, picked per-configuration via the `transport` field (`anthropic_sdk_integration.md` §18):

| Field | `transport: "direct"` (default) | `transport: "agentSdk"` |
| --- | --- | --- |
| Auth source | `ANTHROPIC_API_KEY` env var | Inherited from the host Claude Code install |
| Billing | Anthropic API account | Claude Code subscription / Bedrock / Vertex |
| Prompt caching | Opt-in via `promptCachingEnabled` | SDK-managed (field ignored) |
| Context compaction | Our `history-compaction.ts` | SDK-managed (`historyMode`, `maxHistoryTokens` ignored) |
| Tool-use loop | Hand-rolled in `anthropic-handler.ts` | SDK-managed |
| Memory tools | Same (`tomAi_memory_*`) | Same (`tomAi_memory_*`) — still exposed over MCP |
| Memory → system prompt injection | Yes (§5.2) | No — agent pulls via tools on demand |

To switch, edit the JSON config:

```json
{
  "transport": "agentSdk",
  "agentSdk": {
    "permissionMode": "default",
    "settingSources": [],
    "maxTurns": 40
  }
}
```

Ignored fields on the `agentSdk` path: `apiKeyEnvVar`, `promptCachingEnabled`, `historyMode`, `maxHistoryTokens`. The approval gate still runs — write tools prompt identically on both paths via the SDK's `canUseTool` hook.

The panel shows a 🤖 dot next to the 🔑 dot whenever any configuration has `transport: "agentSdk"`:

- **Green** — `claude --version` succeeded at panel load.
- **Red** — `claude` CLI not found on PATH or exited non-zero. Install Claude Code and run `claude login` or `claude setup-token`, then reload the window.
- **Hidden** — no configuration uses the Agent SDK transport.

A quick summary of every configuration (name, model, transport, permission mode, cache, history) is available on the **Status Page → Anthropic — Configurations** section.

## 3. Create a profile

A profile is a system prompt bound to a configuration. Open the **Global Template Editor** (`Tom AI: Edit Templates` command) and switch to the **Anthropic Profiles** category. Each profile has:

- `systemPrompt` — the system prompt string (or `null` to inherit from the configuration)
- `configurationId` — default configuration id this profile uses
- `isDefault` — whether to preselect on panel load

The profile dropdown in the ANTHROPIC panel is populated from this list.

## 4. Enable memory tools

Two-tier memory (`_ai/memory/shared/` + `_ai/memory/{quest}/`) is exposed via five tools (`tomAi_memory_read`, `_list`, `_save`, `_update`, `_forget`). To let the model write to memory, enable them either per-configuration:

```json
"memoryToolsEnabled": true
```

…or globally via the cross-config defaults:

```json
"anthropic": {
  "memory": {
    "memoryToolsEnabled": true,
    "memoryExtractionTemplateId": "default-memory",
    "autoExtractMode": "trim_and_summary",
    "maxInjectedTokens": 3000
  }
}
```

Memory writes are subject to the approval gate (§8.1) unless the active profile's `toolApprovalMode` is set to `session` or `never`.

## 5. The four template categories

The Anthropic flow uses four template categories, all editable via the **Global Template Editor**:

| Category | Purpose | Where it runs |
| --- | --- | --- |
| `anthropicProfiles` | System-prompt profiles | Sent as `system` on every request (both transports) |
| `anthropicUserMessage` | User-input wrapping (e.g. add file context, role banner) | Wraps each user turn before sending (both transports) |
| `compaction` | History-summary template | `history-compaction.ts` between turns (direct only — SDK compacts on `agentSdk`) |
| `memoryExtraction` | Extract durable facts from a finished exchange | Background pass after each turn (direct only on `agentSdk`) |

The compaction and memory extraction templates support `${userMessage}` (raw user input) plus all the universal placeholders documented in `file_and_prompt_placeholders.md`.

## Related sections of the spec

- §4 Trail system (raw + summary trails for `anthropic` subsystem)
- §6 History compaction (summary / trim_and_summary / llm_extract modes)
- §8.1 Write-tool approval gate
- §10 Status Page — Compaction + Anthropic Memory sections
- §11 Bottom panel — ANTHROPIC accordion
- §14 Configuration schema
- §18 Claude Agent SDK transport (alternative backend)
