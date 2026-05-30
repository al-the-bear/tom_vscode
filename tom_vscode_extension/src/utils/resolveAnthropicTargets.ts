/**
 * Shared resolver for the Anthropic handler's `{profile, configuration}`
 * inputs. Both the queue dispatcher (`promptQueueManager.ts::dispatchStage`)
 * and the chat panel's Anthropic send flow
 * (`chatPanel-handler.ts::_handleSendAnthropic`) need identical logic:
 *
 *   1. Pick the profile by id, fall back to default, fall back to first.
 *   2. Resolve the profile's configurationId (or an override) in
 *      `config.anthropic.configurations` first.
 *   3. If that misses, look in `config.localLlm.configurations` and
 *      synthesise an AnthropicConfiguration with `transport: 'localLlm'`
 *      + the `localLlm` payload — this is the "runtime-synthesised"
 *      type described in `multi_transport_prompt_queue_revised.md §4.3`.
 *
 * Centralising here prevents drift between the two callers.
 */

import { loadSendToChatConfig } from '../handlers/handler_shared';
import type {
    AnthropicConfiguration,
    AnthropicProfile,
} from '../handlers/anthropic-handler';

export interface AnthropicResolutionRequest {
    profileId?: string;
    configId?: string;
    /** Optional per-send override of the configuration's model string (the
     *  Anthropic chat panel's model dropdown supplies this). Not used for
     *  Local-LLM-backed configs — the Local LLM config's own `model` field
     *  wins. */
    modelOverride?: string;
}

export interface AnthropicResolutionResult {
    profile: AnthropicProfile;
    configuration: AnthropicConfiguration;
}

export interface AnthropicResolutionError {
    error: string;
}

/**
 * Resolve `{profileId, configId}` to `{profile, configuration}`, synthesising
 * a `localLlm`-transport AnthropicConfiguration when configId points at a
 * Local LLM entry. Returns an `{ error }` shape on failure so callers can
 * surface the issue without throwing across a module boundary.
 */
export function resolveAnthropicTargets(
    req: AnthropicResolutionRequest,
): AnthropicResolutionResult | AnthropicResolutionError {
    const cfg = loadSendToChatConfig();
    const profiles = (cfg?.anthropic?.profiles ?? []) as AnthropicProfile[];
    const profile = profiles.find((p) => p?.id === req.profileId)
        ?? profiles.find((p) => p?.isDefault === true)
        ?? profiles[0];
    if (!profile) {
        return { error: `No Anthropic profile available (requested id="${req.profileId ?? ''}").` };
    }

    // The chat panel passes `config: ''` rather than omitting the field
    // (see chatPanel-handler.ts webview send action). `??` only falls back
    // on null/undefined, so a stricter check is needed to honour the
    // profile's configurationId in that case.
    const explicitConfigId = (typeof req.configId === 'string' && req.configId.trim().length > 0)
        ? req.configId
        : undefined;
    const configId = explicitConfigId ?? profile.configurationId;
    const explicitConfigRequested = Boolean(configId);
    let configuration = (cfg?.anthropic?.configurations ?? [])
        .find((c) => c?.id === configId) as AnthropicConfiguration | undefined;

    if (!configuration) {
        // Fall back to Local LLM configurations per spec §4.3.
        // On-disk field is `ollamaUrl` (kept for back-compat even when the
        // endpoint is OpenAI-style); we accept legacy `baseUrl` as alias.
        // All knobs that drive the Anthropic dispatcher (maxRounds,
        // historyMode, toolsEnabled, maxTokens) come from the Local LLM
        // configuration so the user can tune them on the Status Page rather
        // than hunt for hardcoded defaults in this synthesiser.
        const localLlmConfigs = (cfg as { localLlm?: { configurations?: Array<{
            id?: string;
            name?: string;
            ollamaUrl?: string;
            baseUrl?: string;
            apiStyle?: 'ollama' | 'openai';
            model?: string;
            temperature?: number;
            keepAlive?: string;
            maxRounds?: number;
            maxTokens?: number;
            toolsEnabled?: boolean;
            historyMode?: 'last' | 'all' | 'full' | 'summary' | 'trim_and_summary' | 'llm_extract';
        }> } })?.localLlm?.configurations;
        const llm = localLlmConfigs?.find((c) => c?.id === configId);
        const llmBaseUrl = llm?.ollamaUrl ?? llm?.baseUrl;
        if (llm && llm.id && llmBaseUrl && llm.model) {
            // Defaults are conservative for small-context Local LLMs.
            // The local-LLM leaf strips tools on the final round, so
            // maxRounds < 2 means tools never reach the model — keep the
            // default >= 2.
            const effectiveMaxRounds = typeof llm.maxRounds === 'number' && llm.maxRounds > 0 ? llm.maxRounds : 10;
            const effectiveHistoryMode = llm.historyMode ?? 'last';
            const effectiveMaxTokens = typeof llm.maxTokens === 'number' && llm.maxTokens > 0 ? llm.maxTokens : 8192;
            const effectiveToolsEnabled = typeof llm.toolsEnabled === 'boolean' ? llm.toolsEnabled : true;
            configuration = {
                id: llm.id,
                name: llm.name || llm.id,
                model: llm.model,
                maxTokens: effectiveMaxTokens,
                maxRounds: effectiveMaxRounds,
                historyMode: effectiveHistoryMode,
                transport: 'localLlm',
                localLlm: {
                    baseUrl: llmBaseUrl,
                    model: llm.model,
                    temperature: typeof llm.temperature === 'number' ? llm.temperature : 0.5,
                    keepAlive: llm.keepAlive,
                    apiStyle: llm.apiStyle,
                    toolsEnabled: effectiveToolsEnabled,
                },
            } as AnthropicConfiguration;
        }
    }

    // Spec §5 failure mode — if a configId was explicitly requested
    // (via req or pinned on the profile) and the lookup missed both
    // stores, surface a clear error rather than silently falling back
    // to the default config. The default-fallback path is reserved
    // for the "no configId at all" case.
    if (!configuration && explicitConfigRequested) {
        return { error: `Configuration "${configId ?? ''}" not found in anthropic.configurations[] or localLlm.configurations[] (profile "${profile.id}").` };
    }

    if (!configuration) {
        // No configId was requested — fall back to the default Anthropic
        // config (respecting isDefault).
        configuration = (cfg?.anthropic?.configurations ?? [])
            .find((c) => c?.isDefault === true) as AnthropicConfiguration | undefined
            ?? (cfg?.anthropic?.configurations ?? [])[0] as AnthropicConfiguration | undefined;
    }

    if (!configuration) {
        return { error: `No Anthropic configuration available (profile "${profile.id}" has no configurationId and there's no default).` };
    }

    // Honour the modelOverride ONLY for non-Local-LLM configurations;
    // a Local LLM config's model is pinned by the stored config itself.
    if (req.modelOverride && configuration.transport !== 'localLlm') {
        configuration = { ...configuration, model: req.modelOverride };
    }

    return { profile, configuration };
}
