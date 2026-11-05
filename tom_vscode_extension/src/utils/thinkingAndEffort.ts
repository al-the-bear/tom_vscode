/* eslint-disable @typescript-eslint/naming-convention -- Messages API wire fields (budget_tokens, output_config) */
/**
 * A profile's thinking and effort, turned into what each model accepts.
 *
 * Profile keys:
 *   - `thinking`: 'adaptive' | 'off' — absent: the model's default (no
 *     `thinking` parameter is sent);
 *   - `effort`: 'low' | 'medium' | 'high' | 'xhigh' | 'max' — absent: the
 *     model's default (Opus 5.5: medium; the others: high);
 *   - `legacyThinkingBudgetTokens`: the thinking budget, used only on models
 *     without adaptive thinking (Haiku 4.5, the 4.5 models and older), where
 *     thinking still means `{type: 'enabled', budget_tokens}`.
 *
 * Older profiles had `thinkingEnabled` + `thinkingBudgetTokens`; the `_ai`
 * format migration rewrites them (format version 3) and profileThinkingSettings
 * still reads them where a profile was not migrated (`thinkingEnabled: false`
 * sent no thinking parameter, so it reads as absent, not as 'off').
 *
 * Model rules (Claude API reference, checked 2026-11-05):
 *   - Opus 5.5, Fable 5 / 5.1, Mythos 5 / 5.1: thinking is always on —
 *     `{type: 'disabled'}` and `budget_tokens` are a 400, so 'off' sends no
 *     `thinking` parameter (lower the effort instead);
 *   - Opus 5: adaptive by default; `{type: 'disabled'}` only at effort high or
 *     below (a 400 at xhigh / max); `budget_tokens` a 400;
 *   - Opus 4.6 – 4.8, Sonnet 4.6, Sonnet 5: `{type: 'adaptive'}` /
 *     `{type: 'disabled'}`; `budget_tokens` a 400 on 4.7, 4.8 and Sonnet 5,
 *     deprecated on 4.6;
 *   - Haiku 4.5 and older: `{type: 'enabled', budget_tokens}` only.
 * Effort (`output_config.effort`, GA): every level on Opus 4.7+ / Fable /
 * Mythos / Sonnet 5; no `xhigh` on Opus / Sonnet 4.6; low – high on Opus 4.5;
 * none on Sonnet 4.5, Haiku 4.5 and older. A setting the model does not take
 * is left out and named in `notes` (the payload dump shows them).
 *
 * vscode-free.
 */

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];
export type ThinkingMode = 'adaptive' | 'off';

/** The budget used on models without adaptive thinking when a profile names none. */
export const DEFAULT_LEGACY_THINKING_BUDGET = 8192;

export interface ThinkingSettings {
    thinking?: ThinkingMode;
    effort?: EffortLevel;
    legacyThinkingBudgetTokens?: number;
}

/** How a model thinks. */
export type ThinkingFamily = 'alwaysOn' | 'opus5' | 'adaptive' | 'budget';

/** The Messages API fields for one request. */
export interface DirectThinkingFields {
    thinking?: { type: 'adaptive' } | { type: 'disabled' } | { type: 'enabled'; budget_tokens: number };
    output_config?: { effort: EffortLevel };
    /** Settings the model does not take, and what was sent instead. */
    notes: string[];
}

/** The Agent SDK options for one query. */
export interface AgentSdkThinkingOptions {
    thinking?: { type: 'adaptive' } | { type: 'disabled' } | { type: 'enabled'; budgetTokens: number };
    effort?: EffortLevel;
    notes: string[];
}

const isEffort = (v: unknown): v is EffortLevel => typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);

/** A profile's settings, from the current keys or, where it was not migrated, the older ones. */
export function profileThinkingSettings(profile: Record<string, unknown> | undefined): ThinkingSettings {
    if (!profile) { return {}; }
    const out: ThinkingSettings = {};
    if (profile.thinking === 'adaptive' || profile.thinking === 'off') {
        out.thinking = profile.thinking;
    } else if (profile.thinkingEnabled === true) {
        // An older profile: `thinkingEnabled: false` sent no thinking parameter, which is the model's default.
        out.thinking = 'adaptive';
    }
    if (isEffort(profile.effort)) { out.effort = profile.effort; }
    const budget = profile.legacyThinkingBudgetTokens ?? profile.thinkingBudgetTokens;
    if (typeof budget === 'number' && Number.isInteger(budget) && budget >= 1024) { out.legacyThinkingBudgetTokens = budget; }
    return out;
}

/** The thinking family of a model id (unknown Claude ids count as current: adaptive). */
export function thinkingFamily(model: string): ThinkingFamily {
    const m = model.toLowerCase();
    if (/fable-5|mythos-5|opus-5-[5-9]/.test(m)) { return 'alwaysOn'; }
    if (/opus-5($|-[1-4]($|\D)|-\d{8}|[^-\d])/.test(m)) { return 'opus5'; }
    if (/opus-4-[678]|sonnet-4-6|sonnet-5/.test(m)) { return 'adaptive'; }
    if (/haiku|claude-3|sonnet-4-5|sonnet-4(?!-)|opus-4-5|opus-4-1|opus-4(?!-)/.test(m)) { return 'budget'; }
    return 'adaptive';
}

/** The effort levels a model takes. */
export function effortLevelsOf(model: string): readonly EffortLevel[] {
    const m = model.toLowerCase();
    if (/opus-4-6|sonnet-4-6/.test(m)) { return ['low', 'medium', 'high', 'max']; }
    if (/opus-4-5/.test(m)) { return ['low', 'medium', 'high']; }
    if (thinkingFamily(model) === 'budget') { return []; }
    return EFFORT_LEVELS;
}

type Thinking = { kind: 'adaptive' } | { kind: 'disabled' } | { kind: 'budget'; tokens: number } | undefined;

function resolve(model: string, s: ThinkingSettings): { thinking: Thinking; effort?: EffortLevel; notes: string[] } {
    const notes: string[] = [];
    const family = thinkingFamily(model);
    let effort: EffortLevel | undefined;
    if (s.effort) {
        if (effortLevelsOf(model).includes(s.effort)) { effort = s.effort; }
        else { notes.push(`effort ${s.effort} is not taken by ${model}; sent without effort`); }
    }
    let thinking: Thinking;
    if (s.thinking === 'adaptive') {
        if (family === 'budget') {
            thinking = { kind: 'budget', tokens: s.legacyThinkingBudgetTokens ?? DEFAULT_LEGACY_THINKING_BUDGET };
        } else {
            thinking = { kind: 'adaptive' };
        }
    } else if (s.thinking === 'off') {
        if (family === 'alwaysOn') {
            notes.push(`thinking cannot be turned off on ${model}; sent without a thinking parameter (lower the effort instead)`);
        } else if (family === 'opus5' && (effort === 'xhigh' || effort === 'max')) {
            notes.push(`thinking cannot be turned off on ${model} at effort ${effort}; sent without a thinking parameter`);
        } else if (family !== 'budget') {
            thinking = { kind: 'disabled' };
        }
    }
    return { thinking, effort, notes };
}

/** What the direct transport sends: `thinking` and `output_config.effort`. */
export function directThinkingFields(model: string, settings: ThinkingSettings): DirectThinkingFields {
    const { thinking, effort, notes } = resolve(model, settings);
    return {
        ...(thinking?.kind === 'adaptive' ? { thinking: { type: 'adaptive' as const } } : {}),
        ...(thinking?.kind === 'disabled' ? { thinking: { type: 'disabled' as const } } : {}),
        ...(thinking?.kind === 'budget' ? { thinking: { type: 'enabled' as const, budget_tokens: thinking.tokens } } : {}),
        ...(effort ? { output_config: { effort } } : {}),
        notes,
    };
}

/** What the Agent SDK is given: its `thinking` and `effort` options. */
export function agentSdkThinkingOptions(model: string, settings: ThinkingSettings): AgentSdkThinkingOptions {
    const { thinking, effort, notes } = resolve(model, settings);
    return {
        ...(thinking?.kind === 'adaptive' ? { thinking: { type: 'adaptive' as const } } : {}),
        ...(thinking?.kind === 'disabled' ? { thinking: { type: 'disabled' as const } } : {}),
        ...(thinking?.kind === 'budget' ? { thinking: { type: 'enabled' as const, budgetTokens: thinking.tokens } } : {}),
        ...(effort ? { effort } : {}),
        notes,
    };
}

/**
 * A profile in the current keys: `thinkingEnabled` / `thinkingBudgetTokens`
 * become `thinking` / `legacyThinkingBudgetTokens` in the place of the first
 * of them (the default budget is dropped). undefined when there is nothing to
 * convert.
 */
export function migrateProfileThinkingKeys(profile: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!('thinkingEnabled' in profile) && !('thinkingBudgetTokens' in profile)) { return undefined; }
    const out: Record<string, unknown> = {};
    let placed = false;
    for (const [key, value] of Object.entries(profile)) {
        if (key !== 'thinkingEnabled' && key !== 'thinkingBudgetTokens') { out[key] = value; continue; }
        if (placed) { continue; }
        placed = true;
        if (profile.thinkingEnabled === true && !('thinking' in profile)) { out.thinking = 'adaptive'; }
        const budget = profile.thinkingBudgetTokens;
        if (typeof budget === 'number' && budget !== DEFAULT_LEGACY_THINKING_BUDGET && !('legacyThinkingBudgetTokens' in profile)) {
            out.legacyThinkingBudgetTokens = budget;
        }
    }
    return out;
}
