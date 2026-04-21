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
 * Shape of the persisted prompt-panel draft for a section. Sections
 * share the common core (text, profile, llmConfig, aiSetup,
 * activeSlot, slots) and may contribute additional per-section
 * fields via the `extras` hook below. Typed loosely as a record so
 * new fields don't require a cross-file TS change.
 */
export interface ChatDraftState {
    text?: string;
    profile?: string;
    template?: string;
    llmConfig?: string;
    aiSetup?: string;
    activeSlot?: number;
    slots?: Record<string, string>;
    [extra: string]: unknown;
}

/**
 * Hooks a chat provider can contribute. All optional — the handler
 * falls back to a default behaviour when a hook is not registered.
 * Every hook is async or pure; the handler awaits them uniformly.
 */
export interface ChatProvider {
    /** Open the "Trail Summary Viewer" (per-file `.prompts.md` / `.answers.md`). */
    openTrailSummary?: () => Promise<void>;

    /**
     * Cancel the in-flight turn for this section. Default behaviour
     * for sections without a hook is a no-op, so registering the
     * hook is the cancel contract.
     */
    cancelInFlight?: () => void;

    /**
     * Send a reusable prompt's expanded contents through this
     * section's normal send path — used by the "play" icon next to
     * reusable-prompt entries. Default for sections without a hook
     * is "send via Copilot" (the review's backwards-compat choice).
     */
    sendReusablePrompt?: (content: string, state: ChatDraftState | undefined) => Promise<void>;

    /**
     * Extract section-specific fields from the in-memory webview
     * draft for persistence. Called by `_saveDrafts()` — the return
     * value is merged into the base YAML payload (alongside text /
     * profile / activeSlot / slots). Return `{}` when the section
     * has no extras.
     */
    persistDraftExtras?: (draft: ChatDraftState) => Record<string, unknown>;

    /**
     * Shape a loaded draft for this section's consumer. Called by
     * `_loadDrafts()` — receives the raw parsed YAML, returns the
     * fields the webview should see. Default behaviour is to pass
     * through the common keys.
     */
    hydrateDraft?: (raw: Record<string, unknown>) => ChatDraftState;

    /**
     * Delete a profile / configuration for this section. Default
     * behaviour is "unknown section — no-op". Registered hook
     * returns true when a delete happened so the caller can refresh
     * state; false when there was nothing to delete.
     */
    deleteProfile?: (profileId: string) => Promise<boolean>;
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
