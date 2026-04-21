/**
 * Chat-provider registry — Wave 3.3 starter.
 *
 * The `@CHAT` webview has five subpanels (Anthropic, Tom AI Chat,
 * AI Conversation, Copilot, Local LLM). Several message handlers in
 * `chatPanel-handler.ts` used to branch on `section === 'anthropic'`
 * vs. "everything else" because the Anthropic subpanel has actions
 * the others don't (its own trail summary viewer, its own session-
 * history file, its own draft extras — model / config /
 * userMessageTemplate on top of the common draft+template pair).
 *
 * The plan calls for collapsing those branches into a provider-map
 * lookup so adding a sixth subpanel stops being a grep-and-branch
 * exercise. This module is the landing place: a tiny registry keyed
 * by section id, where each provider declares the hooks it
 * implements. Unregistered hooks fall back to the handler's existing
 * "default" path.
 *
 * **Current surface:** only `openTrailSummary` is migrated here, as
 * the pilot extraction. The draft-extras + save/load surface stays
 * in the handler for now because it threads through the webview
 * state machine in ways that need per-handler review; that
 * migration is queued as a follow-up.
 */

/** Subpanel id as it appears on webview messages. Stable. */
export type ChatSection = 'anthropic' | 'tomAiChat' | 'conversation' | 'copilot' | 'localLlm';

/**
 * Hooks a chat provider can contribute. All optional — the handler
 * falls back to a default behaviour when a hook is not registered.
 * Every hook is async so handlers can await VS Code API calls
 * uniformly.
 */
export interface ChatProvider {
    /** Open the "Trail Summary Viewer" (per-file `.prompts.md` / `.answers.md`). */
    openTrailSummary?: () => Promise<void>;
}

/**
 * In-module singleton registry. The chat panel registers its providers
 * at construction time and looks them up when routing webview messages.
 * Kept as a module-level map rather than a class so call sites stay
 * terse (`chatProviders.get('anthropic')?.openTrailSummary?.()`) and
 * so test code can register/clear providers without instantiating a
 * singleton holder.
 */
const registry = new Map<ChatSection, ChatProvider>();

export const chatProviders = {
    register(section: ChatSection, provider: ChatProvider): void {
        registry.set(section, provider);
    },
    get(section: ChatSection | string | undefined): ChatProvider | undefined {
        if (!section) { return undefined; }
        return registry.get(section as ChatSection);
    },
    /** Test / reload helper — drops all registered providers. */
    clear(): void {
        registry.clear();
    },
};
