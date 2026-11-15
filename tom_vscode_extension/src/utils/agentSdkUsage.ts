/**
 * The Agent SDK's result accounting, per prompt (qrfix3).
 *
 * Measured in this quest's live trails (2026-11-15, session `default@another`, four
 * consecutive prompts of one resumed session): the result's `usage` and
 * `num_turns` are the prompt's own (they go up and down from prompt to prompt),
 * but `total_cost_usd`, `duration_api_ms` and the per-model `modelUsage` grow
 * over the whole resumed session — $467.54 → $472.41 → $475.81 → $479.56; the
 * opus row's output 2,287,444 → 2,304,394, whose difference is exactly that
 * prompt's own 16,950. Shown as they came, every prompt of a long session
 * reported the session's cost, and the usage ledger (Status Page) added it up
 * again on every prompt.
 *
 * So the cumulative fields are reported as the difference to the previous
 * result of the same session ({@link perPromptUsage}), from a snapshot kept per
 * session id (services/agentSdkUsageSnapshots.ts). Without a snapshot:
 *   - a new session's first result is its own (nothing came before it);
 *   - a resumed session's first result after a restart has no baseline: the
 *     per-prompt token counts stay (`usage`), and cost, API time and the
 *     per-model rows are reported as the session's totals so far
 *     (`sessionSoFar`), never as the prompt's own.
 * A value lower than the snapshot's (the CLI started counting again) is taken
 * as it is.
 *
 * Pure.
 */

import type { LiveTrailModelUsage, LiveTrailUsage } from '../services/live-trail';

/** The cumulative fields of one result, the baseline for the next. */
export interface AgentSdkUsageSnapshot {
    totalCostUsd?: number;
    durationApiMs?: number;
    models: Record<string, ModelCounts>;
}

interface ModelCounts {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
}

const COUNT_KEYS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD'] as const;

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The snapshot of a result's cumulative fields. */
export function snapshotOf(usage: LiveTrailUsage): AgentSdkUsageSnapshot {
    const models: Record<string, ModelCounts> = {};
    for (const m of usage.models ?? []) {
        models[m.model] = {
            inputTokens: n(m.inputTokens), outputTokens: n(m.outputTokens),
            cacheReadInputTokens: n(m.cacheReadInputTokens), cacheCreationInputTokens: n(m.cacheCreationInputTokens),
            costUSD: n(m.costUSD),
        };
    }
    return {
        ...(typeof usage.totalCostUsd === 'number' ? { totalCostUsd: usage.totalCostUsd } : {}),
        ...(typeof usage.durationApiMs === 'number' ? { durationApiMs: usage.durationApiMs } : {}),
        models,
    };
}

/** `current - previous`, or `current` when it is lower (the counting started again). */
function minus(current: number | undefined, previous: number | undefined): number | undefined {
    if (typeof current !== 'number') { return undefined; }
    if (typeof previous !== 'number' || current < previous) { return current; }
    return current - previous;
}

/**
 * The prompt's own usage from a result whose cost, API time and per-model rows
 * may be cumulative over its session. `previous`: the snapshot of the session's
 * previous result; `resumed`: the prompt continued an earlier conversation.
 */
export function perPromptUsage(usage: LiveTrailUsage, previous: AgentSdkUsageSnapshot | undefined, resumed: boolean): LiveTrailUsage {
    if (!previous) {
        if (!resumed) { return usage; }
        // No baseline for a resumed session: the per-query tokens are the prompt's, the rest the session's so far.
        const sessionSoFar: NonNullable<LiveTrailUsage['sessionSoFar']> = {
            ...(typeof usage.totalCostUsd === 'number' ? { totalCostUsd: usage.totalCostUsd } : {}),
            ...(typeof usage.durationApiMs === 'number' ? { durationApiMs: usage.durationApiMs } : {}),
            ...(usage.models && usage.models.length > 0 ? { models: usage.models } : {}),
        };
        const { totalCostUsd: _cost, durationApiMs: _api, models: _models, ...own } = usage;
        return { ...own, ...(Object.keys(sessionSoFar).length > 0 ? { sessionSoFar } : {}) };
    }
    const models: LiveTrailModelUsage[] = [];
    for (const m of usage.models ?? []) {
        const before = previous.models[m.model];
        const row: LiveTrailModelUsage = { model: m.model, ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}) };
        let changed = false;
        for (const key of COUNT_KEYS) {
            const value = minus(m[key], before?.[key]);
            if (value !== undefined) {
                row[key] = value;
                if (value !== 0) { changed = true; }
            }
        }
        // A model the prompt did not use (its counts unchanged) has no row.
        if (changed) { models.push(row); }
    }
    const cost = minus(usage.totalCostUsd, previous.totalCostUsd);
    const api = minus(usage.durationApiMs, previous.durationApiMs);
    const { totalCostUsd: _cost, durationApiMs: _api, models: _models, ...rest } = usage;
    return {
        ...rest,
        ...(models.length > 0 ? { models } : {}),
        ...(cost !== undefined ? { totalCostUsd: cost } : {}),
        ...(api !== undefined ? { durationApiMs: api } : {}),
    };
}
