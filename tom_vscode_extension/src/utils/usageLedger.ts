/**
 * The usage totals the Status Page shows: every send's usage block (any
 * transport — the live trail's `usage` events), summed per day and model.
 *
 * Kept per workspace (the window's workspace state), so each quest window
 * counts its own sends; the data is small — one bucket per day and model, at
 * most {@link MAX_LEDGER_DAYS} days.
 *
 * vscode-free.
 */

import type { LiveTrailUsage } from '../services/live-trail';

/** One day's and one model's sums. */
export interface UsageBucket {
    sends: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number;
    /** Sends with tokens but no cost (an unpriced model, a Local LLM). */
    unpricedSends: number;
}

export interface UsageLedger {
    version: 1;
    /** Since when the since-reset totals count (ISO). */
    resetAt: string;
    /** `YYYY-MM-DD` (local) → model → sums. */
    days: Record<string, Record<string, UsageBucket>>;
}

export interface UsageRow extends UsageBucket {
    model: string;
}

export interface UsageSummary {
    resetAt: string;
    today: UsageRow[];
    todayCostUsd: number;
    sinceReset: UsageRow[];
    sinceResetCostUsd: number;
}

/** Days kept; older ones are dropped as new ones arrive. */
export const MAX_LEDGER_DAYS = 62;

/** The model name a usage block without a model line is counted under. */
export const UNKNOWN_MODEL = '(unknown model)';

export function emptyUsageLedger(now: Date): UsageLedger {
    return { version: 1, resetAt: now.toISOString(), days: {} };
}

/** A ledger read from storage, or an empty one when it is missing or not a ledger. */
export function asUsageLedger(value: unknown, now: Date): UsageLedger {
    const v = value as Partial<UsageLedger> | undefined;
    if (!v || v.version !== 1 || typeof v.resetAt !== 'string' || typeof v.days !== 'object' || v.days === null) {
        return emptyUsageLedger(now);
    }
    return { version: 1, resetAt: v.resetAt, days: v.days as UsageLedger['days'] };
}

function dayKey(d: Date): string {
    const pad = (x: number): string => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyBucket(): UsageBucket {
    return { sends: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0, unpricedSends: 0 };
}

const num = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * The ledger with one send's usage added (a new object; the input is left
 * alone). `countSend: false` adds the tokens and cost of a later round of a
 * send already counted (the direct transport records round by round), so the
 * send is not counted again.
 */
export function recordUsage(ledger: UsageLedger, usage: LiveTrailUsage, at: Date, options: { countSend?: boolean } = {}): UsageLedger {
    const countSend = options.countSend !== false;
    const lines = usage.models && usage.models.length > 0
        ? usage.models
        : (usage.totals ? [{ model: UNKNOWN_MODEL, ...usage.totals, costUSD: usage.totalCostUsd }] : []);
    if (lines.length === 0) { return ledger; }
    const key = dayKey(at);
    const day = { ...(ledger.days[key] ?? {}) };
    for (const line of lines) {
        const b = { ...(day[line.model] ?? emptyBucket()) };
        if (countSend) { b.sends += 1; }
        b.inputTokens += num(line.inputTokens);
        b.outputTokens += num(line.outputTokens);
        b.cacheReadInputTokens += num(line.cacheReadInputTokens);
        b.cacheCreationInputTokens += num(line.cacheCreationInputTokens);
        if (typeof line.costUSD === 'number' && Number.isFinite(line.costUSD)) { b.costUsd += line.costUSD; }
        else if (countSend) { b.unpricedSends += 1; }
        day[line.model] = b;
    }
    const days = { ...ledger.days, [key]: day };
    const keys = Object.keys(days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_LEDGER_DAYS))) { delete days[old]; }
    return { ...ledger, days };
}

/** The ledger with the since-reset totals starting again now (older days are dropped). */
export function resetUsageLedger(_ledger: UsageLedger, now: Date): UsageLedger {
    return emptyUsageLedger(now);
}

function rowsOf(buckets: Array<Record<string, UsageBucket>>): UsageRow[] {
    const byModel = new Map<string, UsageBucket>();
    for (const day of buckets) {
        for (const [model, b] of Object.entries(day)) {
            const acc = byModel.get(model) ?? emptyBucket();
            for (const k of Object.keys(acc) as Array<keyof UsageBucket>) { acc[k] += b[k]; }
            byModel.set(model, acc);
        }
    }
    return [...byModel].map(([model, b]) => ({ model, ...b })).sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));
}

/** Today's and the since-reset totals, per model, most expensive first. */
export function summarizeUsage(ledger: UsageLedger, now: Date): UsageSummary {
    const today = rowsOf(ledger.days[dayKey(now)] ? [ledger.days[dayKey(now)]] : []);
    const sinceReset = rowsOf(Object.values(ledger.days));
    const sum = (rows: UsageRow[]): number => rows.reduce((s, r) => s + r.costUsd, 0);
    return { resetAt: ledger.resetAt, today, todayCostUsd: sum(today), sinceReset, sinceResetCostUsd: sum(sinceReset) };
}
