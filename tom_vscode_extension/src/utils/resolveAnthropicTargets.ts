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

    const configId = req.configId ?? profile.configurationId;
    const explicitConfigRequested = Boolean(configId);
    let configuration = (cfg?.anthropic?.configurations ?? [])
        .find((c) => c?.id === configId) as AnthropicConfiguration | undefined;

    if (!configuration) {
        // Fall back to Local LLM configurations per spec §4.3.
        const localLlmConfigs = (cfg as { localLlm?: { configurations?: Array<{
            id?: string;
            name?: string;
            baseUrl?: string;
            model?: string;
            temperature?: number;
            keepAlive?: string;
        }> } })?.localLlm?.configurations;
        const llm = localLlmConfigs?.find((c) => c?.id === configId);
        if (llm && llm.id && llm.baseUrl && llm.model) {
            configuration = {
                id: llm.id,
                name: llm.name || llm.id,
                model: llm.model,
                maxTokens: 8192,
                maxRounds: 1,
                transport: 'localLlm',
                localLlm: {
                    baseUrl: llm.baseUrl,
                    model: llm.model,
                    temperature: typeof llm.temperature === 'number' ? llm.temperature : 0.5,
                    keepAlive: llm.keepAlive,
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
