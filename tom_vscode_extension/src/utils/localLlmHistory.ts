/**
 * Where a Local LLM profile keeps its history snapshot.
 *
 * The Local LLM has no sessions (they are the Anthropic transports'); its
 * history is per profile: `_ai/quests/<quest>/history/history-<suffix>.{json,md}`,
 * the suffix being the profile's `historySuffix`. A profile without one used to
 * write the plain `history.json` — the Anthropic history of the per-quest
 * layout — so both panels shared one file. Every Anthropic session now keeps
 * its own history (src/services/sessionStorage.ts), so a profile without a
 * suffix gets one of its own: {@link DEFAULT_LOCAL_LLM_HISTORY_SUFFIX}.
 *
 * vscode-free.
 */

/** The suffix of a Local LLM profile without its own `historySuffix`. */
export const DEFAULT_LOCAL_LLM_HISTORY_SUFFIX = 'localLLM';

/** The suffix a profile's history is kept under: its own, else the Local LLM's default. */
export function localLlmHistorySuffix(historySuffix: string | undefined | null): string {
    const own = typeof historySuffix === 'string' ? historySuffix.trim() : '';
    return own || DEFAULT_LOCAL_LLM_HISTORY_SUFFIX;
}
