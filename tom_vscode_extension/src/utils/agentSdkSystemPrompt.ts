/**
 * How an Agent SDK profile's system prompt meets Claude Code's own, and which
 * setting sources it loads (CC-15 (a)).
 *
 * - `systemPromptMode`: `replace` (the default, what every profile did before
 *   the choice existed) sends the profile's prompt as the whole system prompt;
 *   `append` keeps Claude Code's default prompt (the SDK's `claude_code`
 *   preset) and appends the profile's prompt to it.
 * - `settingSources`: which of Claude Code's settings the SDK loads — `user`
 *   (~/.claude), `project` (.claude/ and CLAUDE.md of the workspace), `local`
 *   (.claude/settings.local.json). Set on the profile it wins over the
 *   configuration's `agentSdk.settingSources`; unset, the configuration's
 *   applies.
 *
 * vscode-free.
 */

export type SystemPromptMode = 'replace' | 'append';
export const SYSTEM_PROMPT_MODES: readonly SystemPromptMode[] = ['replace', 'append'];

export type SettingSource = 'user' | 'project' | 'local';
export const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

/** A stored mode; anything but `append` reads as `replace`, so existing profiles keep replacing. */
export function parseSystemPromptMode(value: unknown): SystemPromptMode {
    return value === 'append' ? 'append' : 'replace';
}

/** The SDK's `systemPrompt` option: the text itself, or Claude Code's preset with the text appended. */
export function sdkSystemPromptOption(
    mode: SystemPromptMode,
    text: string,
): string | undefined | { type: 'preset'; preset: 'claude_code'; append?: string } {
    if (mode === 'append') {
        return { type: 'preset', preset: 'claude_code', ...(text ? { append: text } : {}) };
    }
    return text || undefined;
}

/** A stored list of setting sources, valid ones only, in their canonical order; undefined when none is stored. */
export function parseSettingSources(value: unknown): SettingSource[] | undefined {
    if (!Array.isArray(value)) { return undefined; }
    return SETTING_SOURCES.filter((s) => value.includes(s));
}

/** The setting sources a send loads: the profile's when it states them, else the configuration's. */
export function effectiveSettingSources(profileSources: unknown, configurationSources: unknown): SettingSource[] {
    return parseSettingSources(profileSources) ?? parseSettingSources(configurationSources) ?? [];
}
