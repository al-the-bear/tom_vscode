/**
 * The usage block of a send on the transports that do not report one
 * themselves: the direct API (tokens and a cost from the configured price
 * table) and Local LLM configurations (tokens only). The Agent SDK reports its
 * own usage and cost on its `result` message.
 *
 * Prices are configured, never built in: `anthropic.modelPrices` in the
 * extension config, USD per million tokens. A model without an entry keeps its
 * tokens and has no cost — a guessed price would be worse than none.
 *
 * vscode-free.
 */

import type { LiveTrailTokenCounts, LiveTrailUsage } from '../services/live-trail';

/** One entry of the price table: USD per million tokens. */
export interface ModelPrice {
    /** A model id, or the start of one (`claude-opus-5` prices every `claude-opus-5-*`). */
    model: string;
    inputPerMTok: number;
    outputPerMTok: number;
    /** Default: {@link CACHE_READ_FACTOR} × the input price. */
    cacheReadPerMTok?: number;
    /** Default: {@link CACHE_WRITE_FACTOR} × the input price. */
    cacheWritePerMTok?: number;
}

/** A cache read costs this fraction of an input token, unless the entry says otherwise. */
export const CACHE_READ_FACTOR = 0.1;
/** A cache write (5-minute cache) costs this multiple of an input token, unless the entry says otherwise. */
export const CACHE_WRITE_FACTOR = 1.25;

/** The model's price: its exact entry, else the longest entry the model id starts with. */
export function priceFor(model: string, prices: readonly ModelPrice[] | undefined): ModelPrice | undefined {
    const valid = (prices ?? []).filter((p) => !!p && typeof p.model === 'string' && p.model.length > 0);
    const exact = valid.find((p) => p.model === model);
    if (exact) { return exact; }
    return valid
        .filter((p) => model.startsWith(p.model))
        .sort((a, b) => b.model.length - a.model.length)[0];
}

const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** USD for these counts at this price (rounded to 1e-8, so sums stay readable). */
export function costOf(counts: LiveTrailTokenCounts, price: ModelPrice): number {
    const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok * CACHE_READ_FACTOR;
    const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok * CACHE_WRITE_FACTOR;
    const usd = (
        n(counts.inputTokens) * price.inputPerMTok
        + n(counts.outputTokens) * price.outputPerMTok
        + n(counts.cacheReadInputTokens) * cacheRead
        + n(counts.cacheCreationInputTokens) * cacheWrite
    ) / 1_000_000;
    return Math.round(usd * 1e8) / 1e8;
}

/** `a + b`, field by field; a field neither has stays absent. */
export function addTokenCounts(a: LiveTrailTokenCounts, b: LiveTrailTokenCounts): LiveTrailTokenCounts {
    const out: LiveTrailTokenCounts = {};
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'] as const) {
        if (a[key] !== undefined || b[key] !== undefined) { out[key] = n(a[key]) + n(b[key]); }
    }
    return out;
}

/** A Local LLM round's stats (prompt / completion tokens) as token counts. */
export function tokensFromLocalStats(stats: { promptTokens?: number; completionTokens?: number } | undefined): LiveTrailTokenCounts {
    if (!stats) { return {}; }
    const out: LiveTrailTokenCounts = {};
    if (typeof stats.promptTokens === 'number') { out.inputTokens = stats.promptTokens; }
    if (typeof stats.completionTokens === 'number') { out.outputTokens = stats.completionTokens; }
    return out;
}

/** A direct-API send: its totals, one model line priced from the table, and the total cost when priced. */
export function directSendUsage(model: string, totals: LiveTrailTokenCounts, prices: readonly ModelPrice[] | undefined): LiveTrailUsage {
    const price = priceFor(model, prices);
    const costUSD = price ? costOf(totals, price) : undefined;
    return {
        totals,
        models: [{ model, ...totals, ...(costUSD !== undefined ? { costUSD } : {}) }],
        ...(costUSD !== undefined ? { totalCostUsd: costUSD } : {}),
    };
}

/** A Local LLM send: tokens only — a local model costs nothing per token. */
export function localLlmSendUsage(model: string, totals: LiveTrailTokenCounts): LiveTrailUsage {
    return { totals, models: [{ model, ...totals }] };
}
