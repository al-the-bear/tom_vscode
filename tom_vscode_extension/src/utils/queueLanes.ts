/**
 * Queue per run (vscimpb46): the lanes of the prompt queue.
 *
 * With the queue setting **Queue per run** off there is one lane: one item
 * sends at a time, in queue order — the queue as it always was. Every rule
 * here answers that case with the single lane `''`, so the manager's
 * behaviour with the setting off does not change.
 *
 * With it on, each process run has its own lane (`default` the quest's own
 * position; an item without a run belongs to `default`):
 *
 * - one item sends per lane at a time; the lanes send in parallel;
 * - a lane takes its items in queue order: its first pending item is its
 *   next one, and when that one cannot start the lane waits (never skips
 *   ahead), so a run's process-move marker still runs after its step's items;
 * - a held run (Pause per run) starts nothing; its sending item stops before
 *   its next prompt, as with auto-send off;
 * - two prompts never share a conversation: an item does not start while
 *   another sending item runs in its session (Anthropic transport), and the
 *   Copilot transport — one chat, one answer file at a time — has one item
 *   sending at most, whatever its lane;
 * - chat sends (`chat` items) are outside the lanes: they never send through
 *   the queue.
 *
 * Pure: the manager supplies each item's transport session.
 */

import { DEFAULT_RUN, normalizeRun } from './processRuns';

/** The lane of every item while Queue per run is off. */
export const SINGLE_LANE = '';

/** What the lane rules need of a queue item. */
export interface LaneItem {
    id: string;
    status: string;
    run?: string;
    processRun?: { run?: string };
    processMove?: unknown;
}

export interface LaneOptions {
    /** The queue setting Queue per run. */
    perRun: boolean;
    /** The held runs (Pause per run); only read while `perRun` is on. */
    heldRuns: readonly string[];
}

/** The run an item belongs to: its Proceed's, else its own, else `default`. */
export function itemRun(item: LaneItem): string {
    return normalizeRun(item.processRun?.run ?? item.run ?? DEFAULT_RUN);
}

/** The lane of `item`: its run with Queue per run on, else the single lane. */
export function laneOf(item: LaneItem, perRun: boolean): string {
    return perRun ? itemRun(item) : SINGLE_LANE;
}

/** Whether the run of `item` is held (Pause per run), which only applies with Queue per run on. */
export function isLaneHeld(item: LaneItem, opts: LaneOptions): boolean {
    return opts.perRun && opts.heldRuns.includes(itemRun(item));
}

/** The item sending in `lane`, if any. */
export function laneSendingItem<T extends LaneItem>(items: readonly T[], lane: string, perRun: boolean): T | undefined {
    return items.find((i) => i.status === 'sending' && laneOf(i, perRun) === lane);
}

/** How an item would run: its session on the Anthropic transport, `copilot` on the Copilot one. */
export type LaneTarget = { transport: 'anthropic'; session: string } | { transport: 'copilot' };

/**
 * Why `item` cannot start now beside the items already sending (and those
 * chosen to start in the same pass), or undefined when it can. The single
 * lane is busy while anything sends; a lane while its own item sends.
 */
export function laneConflict<T extends LaneItem>(
    item: T,
    sending: readonly T[],
    opts: LaneOptions,
    targetOf: (item: T) => LaneTarget,
): string | undefined {
    const lane = laneOf(item, opts.perRun);
    const sameLane = sending.find((s) => s.id !== item.id && laneOf(s, opts.perRun) === lane);
    if (sameLane) { return opts.perRun ? `run ${lane} is sending ${sameLane.id}` : `${sameLane.id} is sending`; }
    if (!opts.perRun) { return undefined; }
    // A process-move marker sends no prompt: no session, no transport.
    if (item.processMove) { return undefined; }
    const target = targetOf(item);
    for (const s of sending) {
        if (s.id === item.id || s.processMove) { continue; }
        const other = targetOf(s);
        if (target.transport === 'copilot' && other.transport === 'copilot') {
            return `the Copilot chat is busy with ${s.id}`;
        }
        if (target.transport === 'anthropic' && other.transport === 'anthropic' && target.session === other.session) {
            return `session ${target.session} is busy with ${s.id}`;
        }
    }
    return undefined;
}

/**
 * The items to start now, in queue order: per lane its first pending item,
 * when its lane is free, its run not held and it conflicts with nothing
 * sending or chosen before it. With Queue per run off: the first pending item
 * while nothing sends — at most one.
 */
export function pickLaneStarts<T extends LaneItem>(
    items: readonly T[],
    opts: LaneOptions,
    targetOf: (item: T) => LaneTarget,
): T[] {
    const busy: T[] = items.filter((i) => i.status === 'sending');
    const seenLanes = new Set<string>();
    const starts: T[] = [];
    for (const item of items) {
        if (item.status !== 'pending') { continue; }
        const lane = laneOf(item, opts.perRun);
        if (seenLanes.has(lane)) { continue; }
        // The lane's next item: whether it starts or not, the lane's later items wait for it.
        seenLanes.add(lane);
        if (isLaneHeld(item, opts)) { continue; }
        if (laneConflict(item, busy, opts, targetOf)) { continue; }
        starts.push(item);
        busy.push(item);
        if (!opts.perRun) { break; }
    }
    return starts;
}

/** One lane as the queue editor shows it. */
export interface LaneSummary {
    run: string;
    sending: number;
    pending: number;
    held: boolean;
}

/** The lanes of the queue (`default` first, then by name), with what each holds; empty with Queue per run off. */
export function laneSummaries(items: readonly LaneItem[], runs: readonly string[], opts: LaneOptions): LaneSummary[] {
    if (!opts.perRun) { return []; }
    const names = new Set<string>([DEFAULT_RUN, ...runs.map(normalizeRun), ...opts.heldRuns]);
    for (const item of items) {
        if (item.status === 'sending' || item.status === 'pending') { names.add(itemRun(item)); }
    }
    const ordered = [...names].sort((a, b) => Number(b === DEFAULT_RUN) - Number(a === DEFAULT_RUN) || a.localeCompare(b));
    return ordered.map((run) => ({
        run,
        sending: items.filter((i) => i.status === 'sending' && itemRun(i) === run).length,
        pending: items.filter((i) => i.status === 'pending' && itemRun(i) === run).length,
        held: opts.heldRuns.includes(run),
    }));
}
