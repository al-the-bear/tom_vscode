/**
 * The model compaction and memory extraction run on, each chosen on its own
 * (`compaction.compactionModel`, `compaction.memoryExtractionModel`): any
 * Anthropic configuration — on the direct API, the Agent SDK or VS Code LM —
 * or any Local LLM configuration. No fallback list and no per-quest choice. A
 * call runs through the chosen configuration's own transport, so compaction no
 * longer needs a direct-API key.
 *
 * A target is stored as `anthropic:<configuration id>` or
 * `localLlm:<configuration id>`. Without one, the older pair
 * `llmProvider` + `llmConfigId` (one choice for both) is read. Neither set:
 * the configuration id is '' — not configured, and the callers run no
 * compaction, as before.
 *
 * vscode-free.
 */

export type CompactionPurpose = 'compaction' | 'memory';

export interface CompactionTarget {
    kind: 'anthropic' | 'localLlm';
    /** The configuration id; '' = not configured (no call is made). */
    configId: string;
}

/** The compaction section's keys this module reads. */
export interface CompactionTargetSection {
    compactionModel?: unknown;
    memoryExtractionModel?: unknown;
    llmProvider?: unknown;
    llmConfigId?: unknown;
}

/** An Anthropic configuration, as far as routing needs it. */
export interface TargetAnthropicConfig {
    id: string;
    name?: string;
    model?: string;
    transport?: 'direct' | 'agentSdk' | 'vscodeLm' | string;
}

/** A Local LLM configuration, as far as routing needs it. */
export interface TargetLocalConfig {
    id?: string;
    name?: string;
    model?: string;
}

export function encodeCompactionTarget(t: CompactionTarget): string {
    return `${t.kind}:${t.configId}`;
}

export function parseCompactionTarget(value: unknown): CompactionTarget | undefined {
    if (typeof value !== 'string') { return undefined; }
    const at = value.indexOf(':');
    if (at < 0) { return undefined; }
    const kind = value.slice(0, at);
    const configId = value.slice(at + 1);
    if ((kind !== 'anthropic' && kind !== 'localLlm') || configId === '') { return undefined; }
    return { kind, configId };
}

/** The target of `purpose`: its own key, else the older pair; configId '' when neither is set. */
export function resolveCompactionTarget(
    section: CompactionTargetSection | undefined,
    purpose: CompactionPurpose,
): CompactionTarget {
    const own = parseCompactionTarget(purpose === 'compaction' ? section?.compactionModel : section?.memoryExtractionModel);
    if (own) { return own; }
    const legacyId = typeof section?.llmConfigId === 'string' ? section.llmConfigId : '';
    return { kind: section?.llmProvider === 'anthropic' && legacyId ? 'anthropic' : 'localLlm', configId: legacyId };
}

const TRANSPORT_LABEL: Record<string, string> = { direct: 'direct API', agentSdk: 'Agent SDK', vscodeLm: 'VS Code LM' };

/** The dropdown's entries: every Anthropic configuration with its transport, then every Local LLM configuration. */
export function compactionTargetChoices(
    anthropicConfigs: readonly TargetAnthropicConfig[],
    localConfigs: readonly TargetLocalConfig[],
): Array<{ value: string; label: string }> {
    return [
        ...anthropicConfigs.filter((c) => c && c.id).map((c) => ({
            value: encodeCompactionTarget({ kind: 'anthropic', configId: c.id }),
            label: `${c.name || c.id} (${TRANSPORT_LABEL[c.transport ?? 'direct'] ?? c.transport})`,
        })),
        ...localConfigs.filter((c) => c && c.id).map((c) => ({
            value: encodeCompactionTarget({ kind: 'localLlm', configId: c.id as string }),
            label: `${c.name || c.id} (Local LLM)`,
        })),
    ];
}

/** How one call is made: the transport and the configuration it uses. */
export type CompactionRoute<A extends TargetAnthropicConfig = TargetAnthropicConfig, L extends TargetLocalConfig = TargetLocalConfig> =
    | { kind: 'direct' | 'agentSdk' | 'vscodeLm'; configuration: A }
    | { kind: 'localLlm'; localConfig: L }
    | { error: string };

export function routeCompactionTarget<A extends TargetAnthropicConfig, L extends TargetLocalConfig>(
    target: CompactionTarget,
    anthropicConfigs: readonly A[],
    localConfigs: readonly L[],
): CompactionRoute<A, L> {
    if (target.kind === 'anthropic') {
        if (!target.configId) {
            return { error: 'Compaction / memory extraction: no model is chosen — pick one on the Status Page (History Compaction).' };
        }
        const configuration = anthropicConfigs.find((c) => c.id === target.configId);
        if (!configuration) { return { error: `No Anthropic configuration "${target.configId}" for compaction / memory extraction — pick one on the Status Page (History Compaction).` }; }
        const t = configuration.transport;
        return { kind: t === 'agentSdk' ? 'agentSdk' : t === 'vscodeLm' ? 'vscodeLm' : 'direct', configuration };
    }
    if (!target.configId) {
        return { error: 'Compaction / memory extraction: no model is chosen — pick one on the Status Page (History Compaction).' };
    }
    const localConfig = localConfigs.find((c) => c.id === target.configId);
    if (!localConfig) {
        return { error: `No Local LLM configuration "${target.configId}" for compaction / memory extraction — pick one on the Status Page (History Compaction).` };
    }
    return { kind: 'localLlm', localConfig };
}

export interface InternalCallPrompts {
    systemPrompt: string;
    userPrompt: string;
}

/** One runner per transport; each makes a single call with no tools and answers the text. */
export interface InternalCallRunners<A extends TargetAnthropicConfig = TargetAnthropicConfig, L extends TargetLocalConfig = TargetLocalConfig> {
    direct(configuration: A, prompts: InternalCallPrompts): Promise<string>;
    agentSdk(configuration: A, prompts: InternalCallPrompts): Promise<string>;
    vscodeLm(configuration: A, prompts: InternalCallPrompts): Promise<string>;
    localLlm(localConfig: L, prompts: InternalCallPrompts): Promise<string>;
}

/** Make the call the route names; a route that is an error throws it. */
export async function runTargetCall<A extends TargetAnthropicConfig, L extends TargetLocalConfig>(
    route: CompactionRoute<A, L>,
    runners: InternalCallRunners<A, L>,
    prompts: InternalCallPrompts,
): Promise<string> {
    if ('error' in route) { throw new Error(route.error); }
    if (route.kind === 'localLlm') { return runners.localLlm(route.localConfig, prompts); }
    return runners[route.kind](route.configuration, prompts);
}
