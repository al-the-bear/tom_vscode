# Local LLM Integration

The Local LLM is reached through **Anthropic profiles** whose configuration is a Local LLM configuration (`localLlm.configurations`), and through history compaction when it runs on one. There is no Local LLM panel or command of its own. Source: [localLlm-handler.ts](../src/handlers/localLlm-handler.ts) (the `LocalLlmManager` client) and [anthropic-handler.ts](../src/handlers/anthropic-handler.ts) (the `localLlm` transport).

## Local LLM configurations

The `localLlm` section holds `configurations` and `tools` (the `tomAi_askCopilot` / `tomAi_askBigBrother` settings) and nothing else; the removed panel's top-level keys are dropped by the format migration (version 7, `dropLocalLlmPanelKeys` in `src/utils/localLlmProfileMigration.ts`).

Each entry of `localLlm.configurations` names an endpoint (`ollamaUrl`), a model, its sampling and tool settings (`temperature`, `keepAlive`, `toolsEnabled`, `enabledTools`, `maxRounds`, `historyMode`, the per-configuration compaction overrides). They are edited in the Status Page's **LLM Configurations** section. Field reference: [../doc/llm_configuration.md §5](../doc/llm_configuration.md#5-local-llm-configuration-localllm-section).

## Backends (`apiStyle`) and Bearer auth (`apiKeyEnv`)

Each configuration picks a protocol via `apiStyle` (default `'ollama'`):

- `'ollama'` → `GET /api/tags` + `POST /api/chat`.
- `'openai'` → `GET /v1/models` + `POST /v1/chat/completions` — for any **OpenAI-compatible** server (vLLM, LM Studio, llama.cpp, …). `ollamaUrl` is the base URL for both styles; `keepAlive` is ignored on the OpenAI path. Set `toolsEnabled: false` for a backend with no tool-call parser.

`apiKeyEnv` names an env var holding a bearer token (never the secret) for OpenAI-compatible auth; set + non-empty ⇒ `Authorization: Bearer <value>`, unset ⇒ unauthenticated, configured-but-empty ⇒ logged and treated as unset (so a typo fails loud-ish). Full reference, including the compaction-backend interaction: [../doc/llm_configuration.md §5.4](../doc/llm_configuration.md#54-backends-apistyle-and-bearer-auth-apikeyenv).

## The client: `LocalLlmManager.callLocalLlmOnce`

`LocalLlmManager` (a singleton: `getLocalLlmManager` / `ensureLocalLlmManager`) offers one primitive, `callLocalLlmOnce`: one chat request with already-composed messages and `SharedToolDefinition[]` tools, streamed through `onToken`, one model response back (`text`, `stats`, `toolCalls`). It has no tool loop, approval gate or template handling. It dispatches on `apiStyle` to the Ollama or the OpenAI-compatible chat call and retries a busy backend (HTTP 429 / 503 / 529) within a wait budget (`retryTotalWaitMs`, default 10 minutes), reporting each retry through `onRetryStatus`.

## Anthropic profiles on a Local LLM configuration

An Anthropic profile whose `configurationId` resolves to a Local LLM configuration runs on the `localLlm` transport (`resolveAnthropicTargets` synthesises the payload): the Anthropic handler's tool loop, approval gate, user-message templates, history modes, session trails and live trail all apply, and each round calls `callLocalLlmOnce`. Such a profile is picked in the @CHAT Anthropic subpanel and can be a prompt-queue target like any Anthropic profile. Details: [anthropic_chat.md](anthropic_chat.md).

## Compaction on a Local LLM configuration

`compaction.compactionModel: "localLlm:<configuration id>"` runs history compaction on a Local LLM configuration through `callLocalLlmOnce` ([history-compaction.ts](../src/services/history-compaction.ts)), honouring the configuration's `apiStyle` and `apiKeyEnv`.

## Output channels

- **Tom AI Local Log** — debug output (endpoint, timing, retries, auth misses).

## Guidance

- Keep the configuration schema backward-compatible — users have saved configurations on disk.
- A change to `callLocalLlmOnce` affects both the `localLlm` transport and compaction: test both.
