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

import type { LiveTrailTokenCounts, LiveTrailToolTurns, LiveTrailUsage } from '../services/live-trail';
import { addAssistantTurn, emptyToolTurns } from './parallelToolCalls';

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

/**
 * A direct send's usage, round by round. Each round's usage goes to `record`
 * (the usage ledger) as its response arrives — the first round of the send as a
 * new send, later ones as more of it — so a send that ends in an error (out of
 * credit, a 400, a cancel) has still been counted for what it used.
 * {@link sendUsage} is the send's block for the live trail: the totals of every
 * round, marked as already in the ledger.
 */
export class DirectSendUsage {
    private sum: LiveTrailTokenCounts = {};
    private rounds = 0;
    private turns: LiveTrailToolTurns = emptyToolTurns();

    constructor(
        private readonly model: string,
        private readonly prices: readonly ModelPrice[] | undefined,
        private readonly record: (round: LiveTrailUsage, firstOfSend: boolean) => void,
    ) {}

    /** One round's token counts (a round that reported none is not recorded). */
    addRound(round: LiveTrailTokenCounts): void {
        if (Object.keys(round).length === 0) { return; }
        this.sum = addTokenCounts(this.sum, round);
        const first = this.rounds === 0;
        this.rounds += 1;
        try {
            this.record(directSendUsage(this.model, round, this.prices), first);
        } catch { /* the ledger is a convenience; the send goes on */ }
    }

    /** One assistant turn and the number of tool calls it made (the parallel-calls share). */
    addTurn(toolCalls: number): void {
        this.turns = addAssistantTurn(this.turns, toolCalls);
    }

    /** The turns counted so far. */
    get toolTurns(): LiveTrailToolTurns { return this.turns; }

    /** The token counts of every round so far. */
    get totals(): LiveTrailTokenCounts { return this.sum; }

    /** The send's usage block, or undefined when no round reported usage. */
    sendUsage(): LiveTrailUsage | undefined {
        if (this.rounds === 0) { return undefined; }
        return {
            ...directSendUsage(this.model, this.sum, this.prices),
            ...(this.turns.assistantTurns > 0 ? { toolTurns: this.turns } : {}),
            recordedInLedger: true,
        };
    }
}
