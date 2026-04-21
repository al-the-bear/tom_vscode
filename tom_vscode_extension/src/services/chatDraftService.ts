/**
 * Chat draft persistence service.
 *
 * Wave 3.2 extraction — the `_saveDrafts` / `_loadDrafts` pair used
 * to live on `ChatPanelViewProvider` as two private methods that
 * knew (a) the full list of chat sections, (b) the common draft
 * shape, and (c) which per-section extras each provider persisted.
 * Two of those three concerns are now owned elsewhere — the
 * provider registry knows the extras shape, and `panelYamlStore.ts`
 * knows the on-disk format — which left the handler holding only
 * the iteration + messaging glue.
 *
 * This module pulls that glue out so the handler can just call
 * `saveChatDrafts(drafts)` / `loadChatDrafts()` and get back the
 * shaped state to forward to the webview.
 */

import { chatProviders, ChatDraftState, ChatSection } from '../handlers/chat/chatProviderRegistry';

/**
 * Canonical list of chat sections. Kept here (rather than inside the
 * handler) so draft persistence stays the one place that iterates
 * across every section when adding or removing one.
 */
export const CHAT_SECTIONS: ChatSection[] = ['localLlm', 'conversation', 'copilot', 'tomAiChat', 'anthropic'];

/**
 * Persist a per-section draft map to the prompt-panel YAML files.
 * Per-section extras (e.g. Anthropic's model / config /
 * userMessageTemplate) come from the provider registry; sections
 * without a `persistDraftExtras` hook persist only the common core.
 */
export async function saveChatDrafts(drafts: Record<string, ChatDraftState>): Promise<void> {
    try {
        const { writePromptPanelYaml } = await import('../utils/panelYamlStore.js');
        await Promise.all(
            CHAT_SECTIONS.map(async (section) => {
                const d = drafts[section] || {};
                const base: Record<string, unknown> = {
                    text: d.text || '',
                    profile: d.profile || '',
                    llmConfig: d.llmConfig || '',
                    aiSetup: d.aiSetup || '',
                    activeSlot: d.activeSlot || 1,
                    slots: d.slots || {},
                };
                const extras = chatProviders.get(section)?.persistDraftExtras?.(d);
                if (extras) {
                    Object.assign(base, extras);
                }
                await writePromptPanelYaml(section, base);
            })
        );
    } catch (e) {
        console.error('[chatDraftService] Failed to save drafts:', e);
    }
}

/**
 * Read the per-section draft map back from the prompt-panel YAML
 * files. Returns an object keyed by section id; missing sections
 * (files not yet created) are absent from the result.
 */
export async function loadChatDrafts(): Promise<Record<string, ChatDraftState>> {
    try {
        const { readPromptPanelYaml } = await import('../utils/panelYamlStore.js');
        const loaded: Record<string, ChatDraftState> = {};
        for (const section of CHAT_SECTIONS) {
            const data = await readPromptPanelYaml<Record<string, unknown>>(section);
            if (data) {
                const base: ChatDraftState = {
                    text: (data.text as string) || '',
                    profile: (data.profile as string) || '',
                    llmConfig: (data.llmConfig as string) || '',
                    aiSetup: (data.aiSetup as string) || '',
                    activeSlot: (data.activeSlot as number) || 1,
                    slots: (data.slots as Record<string, string>) || {},
                };
                const extras = chatProviders.get(section)?.hydrateDraft?.(data) ?? {};
                loaded[section] = { ...base, ...extras };
            }
        }
        return loaded;
    } catch {
        return {};
    }
}
