/**
 * What each process run of a window is doing (vscimpb123): the per-run
 * entries a window writes into its state file with every heartbeat, which the
 * @TOM INFO › RUNS view and tomAi_getQuestWindowStatus read.
 *
 * A run's state, from its queue items, the window's open user interactions
 * (services/userInteractions) and its auto-send — the most specific wins:
 *
 *   waiting for user  > interrupted > waiting for event > waiting on task > running > paused > idle
 *
 * - `waiting for user`: an ask, approval, plan proposal, picker or MD Browser
 *   ask of the run is open (named by its title), or an item of the run is held
 *   on its todo's open decisions (`decision-needed`);
 * - `interrupted`: an item of the run is held for continuation (`interrupted`,
 *   it resends when the run is resumed) or soft-interrupted (its turn stops at
 *   the next hold point, or is held there): the run does not go on by itself;
 * - `waiting for event`: the run's turn waits in tomAi_waitFor (reason, until);
 * - `waiting on task`: the run's turn waits for its own background tasks or
 *   command streams (named);
 * - `running`: an item of the run is sending, or pending items are about to
 *   be sent (auto-send on);
 * - `paused`: the run's auto-send is off (with its pending count) — also while
 *   its item is still `sending` between two iterations of a walk or a repeat
 *   (no answer in flight: it goes on only once the run is resumed);
 * - `idle`: nothing pending.
 *
 * vscode-free and pure.
 */

import { itemRun } from './queueLanes';
import { normalizeRun } from './processRuns';

export type RunActivityState = 'waiting for user' | 'interrupted' | 'waiting for event' | 'waiting on task' | 'running' | 'paused' | 'idle';

/** The states, the most specific first: when several apply, the first wins. */
export const RUN_STATE_PRECEDENCE: readonly RunActivityState[] = ['waiting for user', 'interrupted', 'waiting for event', 'waiting on task', 'running', 'paused', 'idle'];

/** A queue item, as far as the run state reads it. */
export interface RunActivityItem {
    id: string;
    status: string;
    run?: string;
    processRun?: { run?: string };
    /** A process-move marker: never sent, not counted as pending work. */
    processMove?: unknown;
    originalText?: string;
    /** A `todo-blocked` item: the todo it is held at and what that waits for. */
    blockedOn?: string;
    /** Its turn waits in tomAi_waitFor. */
    waitingFor?: { reason: string; until: string };
    /** Its turn waits for its own background work. */
    backgroundWait?: { items?: ReadonlyArray<{ description?: string; command?: string; id?: string }> };
    /** A soft interrupt of its turn: requested (waits for a hold point) or held (`heldAt`). */
    softInterrupt?: { requestedAt?: number; heldAt?: number };
    /** A prompt of a `sending` item is genuinely in flight; unset between two iterations. */
    awaitingAnswer?: boolean;
}

/** An open user interaction, as far as the run state reads it. */
export interface RunActivityInteraction {
    run: string;
    title: string;
}

/** A run of the window's quest (ProcessStateStore.runs()). */
export interface RunInfo {
    run: string;
    process?: string;
    position?: string;
    subject?: string;
    /** The run this window works on. */
    current?: boolean;
}

/** What a run is doing. */
export interface RunActivity {
    state: RunActivityState;
    /** What it waits for, or what it sends; absent for idle. */
    detail?: string;
    /** Its pending items (process-move markers left out). */
    pending: number;
}

/** One run in the window's state file. */
export interface RunActivityEntry extends RunActivity {
    run: string;
    /** The process it follows; absent for none. */
    process?: string;
    /** Its position (`phase › step`), when it follows a process. */
    position?: string;
    /** Its `process-subject` (what it works on). */
    subject?: string;
    /** The run this window works on. */
    current?: true;
}

/** Statuses of an item whose turn is out (the run is running). */
const ACTIVE = new Set(['sending', 'waiting', 'retry']);

function oneLine(text: string, max = 80): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Several names in one line: the first ones and how many more. */
function listOf(names: readonly string[], max = 2): string {
    const shown = names.slice(0, max).join('; ');
    return names.length > max ? `${shown} (+${names.length - max} more)` : shown;
}

/** What run `run` is doing. */
export function runActivity(
    run: string,
    items: readonly RunActivityItem[],
    interactions: readonly RunActivityInteraction[],
    paused: boolean,
): RunActivity {
    const name = normalizeRun(run);
    const own = items.filter((i) => itemRun({ id: i.id, status: i.status, run: i.run, processRun: i.processRun }) === name);
    const pending = own.filter((i) => i.status === 'pending' && !i.processMove).length;
    const active = own.filter((i) => ACTIVE.has(i.status));

    const asks = interactions.filter((i) => normalizeRun(i.run) === name).map((i) => i.title || 'a question');
    const decisions = [
        ...own.filter((i) => i.status === 'decision-needed').map((i) => `todo decisions: ${oneLine(i.originalText ?? i.id, 50)}`),
        // Held because its todo waits for one that is not completed.
        ...own.filter((i) => i.status === 'todo-blocked').map((i) => `blocked: ${oneLine(i.blockedOn ?? i.originalText ?? i.id, 80)}`),
    ];
    if (asks.length || decisions.length) { return { state: 'waiting for user', detail: listOf([...asks, ...decisions]), pending }; }

    // Held for continuation, or soft-interrupted: it does not go on by itself.
    const held = own.find((i) => i.status === 'interrupted');
    if (held) { return { state: 'interrupted', detail: `${oneLine(held.originalText ?? held.id, 60)} — resends when the run is resumed`, pending }; }
    const soft = own.find((i) => i.status === 'sending' && i.softInterrupt);
    if (soft?.softInterrupt) {
        return { state: 'interrupted', detail: `${oneLine(soft.originalText ?? soft.id, 60)} — ${soft.softInterrupt.heldAt ? 'held at a hold point' : 'stops at the next hold point'}`, pending };
    }

    const event = active.find((i) => i.waitingFor);
    if (event?.waitingFor) { return { state: 'waiting for event', detail: `${event.waitingFor.reason} (until ${event.waitingFor.until})`, pending }; }

    const tasks = active.flatMap((i) => i.backgroundWait?.items ?? []).map((w) => w.description || w.command || w.id || 'background work');
    if (tasks.length) { return { state: 'waiting on task', detail: listOf(tasks), pending }; }

    // A walk or repeat paused between iterations: still `sending`, but no answer in flight and its run paused.
    const between = paused ? active.find((i) => i.status === 'sending' && !i.awaitingAnswer) : undefined;
    if (between && active.every((i) => i.status !== 'sending' || !i.awaitingAnswer)) {
        return { state: 'paused', detail: `between iterations: ${oneLine(between.originalText ?? between.id, 60)}${pending ? `, ${pending} pending` : ''}`, pending };
    }
    if (active.length) { return { state: 'running', detail: oneLine(active[0].originalText ?? active[0].id), pending }; }
    if (paused) { return { state: 'paused', detail: `${pending} pending`, pending }; }
    if (pending) { return { state: 'running', detail: `${pending} pending, about to be sent`, pending }; }
    return { state: 'idle', pending };
}

/** The entries of every run of the window's quest, in the order given. */
export function runActivityEntries(
    runs: readonly RunInfo[],
    items: readonly RunActivityItem[],
    interactions: readonly RunActivityInteraction[],
    pausedRuns: readonly string[],
): RunActivityEntry[] {
    const paused = new Set(pausedRuns.map(normalizeRun));
    return runs.map((r) => {
        const name = normalizeRun(r.run);
        return {
            run: name,
            ...(r.process ? { process: r.process } : {}),
            ...(r.process && r.position ? { position: r.position } : {}),
            ...(r.subject ? { subject: r.subject } : {}),
            ...(r.current ? { current: true as const } : {}),
            ...runActivity(name, items, interactions, paused.has(name)),
        };
    });
}

// ---------------------------------------------------------------------------
// The RUNS view: windows grouped, gone ones shown then dropped
// ---------------------------------------------------------------------------

/** How long a gone window (no heartbeat for 90 s) is still shown: until 10 minutes after its last heartbeat. */
export const GONE_WINDOW_SHOWN_MS = 10 * 60_000;

/** A window-state file as the view reads it. */
export interface RunsOverviewState {
    windowId: string;
    workspace?: string;
    activeQuest?: string;
    host?: string;
    heartbeat?: string;
    runs?: RunActivityEntry[];
}

/** One window in the view. */
export interface RunsOverviewWindow {
    windowId: string;
    quest: string;
    workspace: string;
    alive: boolean;
    isThisWindow: boolean;
    /** Seconds since its last heartbeat. */
    heartbeatAgeSeconds?: number;
    runs: RunActivityEntry[];
}

/**
 * The windows of the RUNS view: those of this machine with a heartbeat
 * (`thisHost`, else a window id ending in this machine's id), alive ones
 * first (this window on top), then by quest; a window without a heartbeat
 * for `staleMs` is gone, and after `droppedMs` it is left out.
 */
export function runsOverviewWindows(
    states: readonly RunsOverviewState[],
    opts: { nowMs: number; thisWindowId: string; thisHost: string; thisMachine: string; staleMs: number; droppedMs?: number },
): RunsOverviewWindow[] {
    const dropped = opts.droppedMs ?? GONE_WINDOW_SHOWN_MS;
    const onThisHost = (s: RunsOverviewState): boolean => (s.host ? s.host === opts.thisHost : s.windowId.endsWith(`_${opts.thisMachine}`));
    return states
        .filter(onThisHost)
        .map((s): RunsOverviewWindow | undefined => {
            const at = s.heartbeat ? Date.parse(s.heartbeat) : NaN;
            const isThisWindow = s.windowId === opts.thisWindowId;
            if (!Number.isFinite(at) && !isThisWindow) { return undefined; }
            const age = Number.isFinite(at) ? Math.max(0, opts.nowMs - at) : 0;
            if (!isThisWindow && age > dropped) { return undefined; }
            return {
                windowId: s.windowId,
                quest: s.activeQuest || '',
                workspace: s.workspace || '',
                alive: isThisWindow || age <= opts.staleMs,
                isThisWindow,
                ...(Number.isFinite(at) ? { heartbeatAgeSeconds: Math.round(age / 1000) } : {}),
                runs: s.runs ?? [],
            };
        })
        .filter((w): w is RunsOverviewWindow => !!w)
        .sort((a, b) => (Number(b.isThisWindow) - Number(a.isThisWindow))
            || (Number(b.alive) - Number(a.alive))
            || a.quest.localeCompare(b.quest)
            || a.workspace.localeCompare(b.workspace)
            || a.windowId.localeCompare(b.windowId));
}
