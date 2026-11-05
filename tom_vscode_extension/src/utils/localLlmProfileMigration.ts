/**
 * The `_ai` format migration's part for the removed panels (format version 5):
 * the Local LLM, Tom AI Chat and AI Conversation panels go, and the Local LLM
 * is reached through Anthropic profiles whose configuration is a Local LLM
 * configuration (resolveAnthropicTargets.ts synthesises the `localLlm`
 * transport for them).
 *
 *   - Each `localLlm.profiles` entry becomes an Anthropic profile
 *     `local-<key>` on the Local LLM configuration it names (its
 *     `modelConfig`, else the Local LLM's default configuration), with its
 *     system prompt, tools and history settings. What an Anthropic profile has
 *     no field for — temperature, result template, thinking-tag stripping (all
 *     the configuration's), the history and memory suffixes (sessions replace
 *     them), being the default — is named in the change and dropped. The
 *     `localLlm.profiles` block is removed.
 *   - The files only those panels wrote are deleted: the Local LLM histories
 *     (`history/history-<suffix>.{json,md}`), `live-trail-localLLM.md`, the
 *     `localllm-*` summary trail pairs, the raw trails `_ai/trail/localllm/` and
 *     `_ai/trail/local_llm/`, and the AI Conversation results and logs
 *     (`_ai/ai_conversation/`, `_ai/trail/ai_conversation/`). Only when the
 *     files are migrated from a format version below 5: afterwards the
 *     Anthropic profiles on Local LLM configurations write their raw trail
 *     into `_ai/trail/localllm/` again, and that is not deleted.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The format version whose migration converts the profiles and deletes the files. */
export const REMOVED_PANELS_FORMAT_VERSION = 5;

export interface LocalLlmProfileEntry {
    label?: unknown;
    systemPrompt?: unknown;
    resultTemplate?: unknown;
    temperature?: unknown;
    modelConfig?: unknown;
    isDefault?: unknown;
    toolsEnabled?: unknown;
    enabledTools?: unknown;
    maxRounds?: unknown;
    historyMode?: unknown;
    stripThinkingTags?: unknown;
    historySuffix?: unknown;
    memorySuffix?: unknown;
    autoInjectMemory?: unknown;
}

/** The Anthropic profile id for a Local LLM profile key. */
export function localProfileId(key: string): string {
    const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `local-${slug || 'profile'}`;
}

/** The Local LLM's default configuration: the one marked `isDefault`, else the first. */
export function defaultLocalLlmConfigId(configurations: unknown): string | undefined {
    if (!Array.isArray(configurations)) { return undefined; }
    const withId = configurations.filter((c) => c && typeof (c as { id?: unknown }).id === 'string') as Array<{ id: string; isDefault?: unknown }>;
    return (withId.find((c) => c.isDefault === true) ?? withId[0])?.id;
}

export interface ConvertedProfile {
    profile: Record<string, unknown>;
    /** Settings of the Local LLM profile that have no place on an Anthropic profile. */
    dropped: string[];
}

/** One Local LLM profile as an Anthropic profile on `configId`. */
export function localLlmProfileToAnthropic(key: string, p: LocalLlmProfileEntry, configId: string): ConvertedProfile {
    const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim() : key;
    const enabledTools = Array.isArray(p.enabledTools) ? p.enabledTools.filter((t): t is string => typeof t === 'string') : [];
    const tools = enabledTools.length > 0
        ? { toolsEnabled: false, enabledTools }
        : p.toolsEnabled === false ? { toolsEnabled: false, enabledTools: [] as string[] } : { toolsEnabled: true };
    const profile: Record<string, unknown> = {
        id: localProfileId(key),
        name: `${label} (Local LLM)`,
        description: `Migrated from the Local LLM profile "${key}".`,
        systemPrompt: typeof p.systemPrompt === 'string' ? p.systemPrompt : '',
        configurationId: configId,
        ...tools,
        ...(typeof p.maxRounds === 'number' ? { maxRounds: p.maxRounds } : {}),
        ...(typeof p.historyMode === 'string' ? { historyMode: p.historyMode } : {}),
        ...(p.autoInjectMemory === true ? { autoInjectMemory: true } : {}),
    };
    const dropped: string[] = [];
    if (typeof p.temperature === 'number') { dropped.push(`temperature ${p.temperature}`); }
    if (typeof p.resultTemplate === 'string' && p.resultTemplate !== '${response}') { dropped.push('resultTemplate'); }
    if (typeof p.stripThinkingTags === 'boolean') { dropped.push('stripThinkingTags'); }
    if (typeof p.historySuffix === 'string' && p.historySuffix) { dropped.push(`historySuffix ${p.historySuffix}`); }
    if (typeof p.memorySuffix === 'string' && p.memorySuffix) { dropped.push(`memorySuffix ${p.memorySuffix}`); }
    if (p.isDefault === true) { dropped.push('isDefault'); }
    return { profile, dropped };
}

/** The files and folders only the removed panels wrote, under `aiRoot`, for `quests`. */
export function removedPanelPaths(aiRoot: string, quests: string[]): string[] {
    const out: string[] = [];
    const exists = (p: string) => fs.existsSync(p);
    for (const quest of quests) {
        const qdir = path.join(aiRoot, 'quests', quest);
        const live = path.join(qdir, 'live-trail-localLLM.md');
        if (exists(live)) { out.push(live); }
        const hdir = path.join(qdir, 'history');
        if (!exists(hdir)) { continue; }
        for (const name of fs.readdirSync(hdir).sort()) {
            if (/^history-.+\.(json|md)$/.test(name)) { out.push(path.join(hdir, name)); }
            else if (name.startsWith(`${quest}.localllm-`) && /\.(prompts|answers)\.md$/.test(name)) { out.push(path.join(hdir, name)); }
        }
    }
    for (const rel of [['trail', 'localllm'], ['trail', 'local_llm'], ['trail', 'ai_conversation'], ['ai_conversation']]) {
        const p = path.join(aiRoot, ...rel);
        if (exists(p)) { out.push(p); }
    }
    return out;
}

/**
 * The config without the removed panels' sections: `tomAiChat`,
 * `aiConversation` but its `telegram` block, `localLlm.expansionProfile`.
 * Answers the keys removed ([] when there were none).
 */
export function dropRemovedPanelSections(cfg: Record<string, unknown>): string[] {
    const removed: string[] = [];
    if ('tomAiChat' in cfg) { delete cfg.tomAiChat; removed.push('tomAiChat'); }
    const conv = cfg.aiConversation;
    if (conv && typeof conv === 'object') {
        const telegram = (conv as { telegram?: unknown }).telegram;
        const others = Object.keys(conv).filter((k) => k !== 'telegram');
        if (others.length > 0) {
            if (telegram !== undefined) { cfg.aiConversation = { telegram }; } else { delete cfg.aiConversation; }
            removed.push(...others.map((k) => `aiConversation.${k}`));
        }
    } else if ('aiConversation' in cfg) {
        delete cfg.aiConversation; removed.push('aiConversation');
    }
    const local = cfg.localLlm;
    if (local && typeof local === 'object' && 'expansionProfile' in local) {
        delete (local as Record<string, unknown>).expansionProfile;
        removed.push('localLlm.expansionProfile');
    }
    return removed;
}
