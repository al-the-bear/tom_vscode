/**
 * The process-move marker: how a process step ends with its queue.
 *
 * Proceed queues the step's prompt and, after it, a marker item (a queue entry
 * of its own kind, never sent to a model) that moves the process to the next
 * position when the queue reaches it. Every item queued while a prompt of that
 * Proceed runs — todo walks, closing items, follow-ups an agent queues —
 * carries the same Proceed run (`processRun.proceedId`, inherited by
 * processRunContext) and is inserted before the marker, so the state moves
 * only once all of them are done:
 *
 *   - every earlier item of the run sent: the marker moves the process;
 *   - one of them failed: the marker is held (the step "failed — see the
 *     queue"; Proceed offers to repeat the step or move on);
 *   - otherwise (still pending, sending, waiting, staged, held for decisions):
 *     the marker waits, and so does the queue behind it.
 *
 * These are the rules, over a minimal item shape; the queue manager applies
 * them and the PROCESS view reads {@link stepRunProgress}. vscode-free.
 */

import type { ProcessLevel, ProcessMoveKind } from './processDefinition';
import type { ProcessRun } from '../services/processRunContext';
import { normalizeRun } from './processRuns';

/** The move a marker makes when the queue reaches it. */
export interface ProcessMoveSpec {
    kind: ProcessMoveKind;
    level?: ProcessLevel;
    /** The move's label in the action bar. */
    label: string;
    /** The position it leads to, as text. */
    to: string;
}

/** What the rules need of a queue item. */
export interface MarkerQueueItem {
    id: string;
    status: string;
    processRun?: ProcessRun;
    processMove?: ProcessMoveSpec;
}

/** What a marker does when the queue reaches it. */
export type MarkerVerdict = 'move' | 'wait' | 'held';

/** The marker's queue text (what the queue editor shows). */
export function markerText(spec: ProcessMoveSpec): string {
    return `⏭ move the process to ${spec.to}`;
}

/** A fresh Proceed run id. */
export function newProceedId(now = Date.now(), random = Math.random()): string {
    return `proceed-${now.toString(36)}-${Math.floor(random * 0x100000).toString(36)}`;
}

/** True when both belong to the same Proceed run. */
export function sameProceedRun(a: ProcessRun | undefined, b: ProcessRun | undefined): boolean {
    return !!a?.proceedId && a.proceedId === b?.proceedId;
}

function isMarker(item: MarkerQueueItem): boolean {
    return !!item.processMove;
}

/** A marker that has not moved the process yet (waiting or held). */
function isOpenMarker(item: MarkerQueueItem): boolean {
    return isMarker(item) && item.status !== 'sent';
}

/**
 * Where a newly queued item of `run` goes: before the open marker of its
 * Proceed run; -1 when there is none (it goes where it would otherwise).
 */
export function markerInsertIndex(items: readonly MarkerQueueItem[], run: ProcessRun | undefined): number {
    if (!run?.proceedId) { return -1; }
    return items.findIndex((i) => isOpenMarker(i) && sameProceedRun(i.processRun, run));
}

/** The items of the marker's run before it (the marker excluded). */
function runItemsBefore(items: readonly MarkerQueueItem[], marker: MarkerQueueItem): MarkerQueueItem[] {
    const at = items.indexOf(marker);
    return items.slice(0, at < 0 ? items.length : at)
        .filter((i) => !isMarker(i) && sameProceedRun(i.processRun, marker.processRun));
}

/** What the marker does now: move, wait for its run's items, or hold on a failed one. */
export function markerVerdict(items: readonly MarkerQueueItem[], marker: MarkerQueueItem): MarkerVerdict {
    const before = runItemsBefore(items, marker);
    if (before.some((i) => i.status === 'error')) { return 'held'; }
    if (before.some((i) => i.status !== 'sent')) { return 'wait'; }
    return 'move';
}

/** A quest's running step, as the PROCESS view shows it. */
export interface StepRunProgress {
    markerId: string;
    proceedId: string;
    /** The items of the run not yet sent (the marker not counted). */
    left: number;
    /** The marker is held: an item of the run failed. */
    held: boolean;
    /** The move the marker makes. */
    move: ProcessMoveSpec;
    /** The position the run belongs to. */
    run: ProcessRun;
}

/**
 * The open marker of `quest` (the first, if several) and how far its run is;
 * undefined when no step is running. With `level`, only a run queued for that
 * level of the process stack counts: a step below a running subprocess may
 * still have items queued, and the subprocess's first Proceed goes in behind
 * them.
 */
export function stepRunProgress(items: readonly MarkerQueueItem[], quest: string, level?: number, run?: string): StepRunProgress | undefined {
    const marker = items.find((i) => isOpenMarker(i) && i.processRun?.quest === quest && ofRun(i.processRun, run)
        && (level === undefined || (i.processRun.level ?? 0) === level));
    if (!marker?.processMove || !marker.processRun?.proceedId) { return undefined; }
    const runItems = items.filter((i) => !isMarker(i) && sameProceedRun(i.processRun, marker.processRun));
    return {
        markerId: marker.id,
        proceedId: marker.processRun.proceedId,
        left: runItems.filter((i) => i.status !== 'sent').length,
        held: marker.status === 'error' || markerVerdict(items, marker) === 'held',
        move: marker.processMove,
        run: marker.processRun,
    };
}

/** The open markers of `quest` — of its run `run` when given (what Skip, Back and a set state remove). */
export function openMarkerIds(items: readonly MarkerQueueItem[], quest: string, run?: string): string[] {
    return items.filter((i) => isOpenMarker(i) && i.processRun?.quest === quest && ofRun(i.processRun, run)).map((i) => i.id);
}

/** Whether a queued position belongs to run `run` (every run when `run` is undefined; an item without one is `default`'s). */
function ofRun(position: ProcessRun | undefined, run: string | undefined): boolean {
    return run === undefined || normalizeRun(position?.run) === normalizeRun(run);
}
