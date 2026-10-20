/**
 * The process position a prompt runs for, while it runs.
 *
 * Proceed queues the prompt of the current position and moves the quest on at
 * once, so by the time the queue sends the prompt — and the todo walks that
 * prompt queues in turn — the quest's state may already be at the next step.
 * The prompt must still run as the step it belongs to: with that step's role
 * and that position in the system prompt's *Current process* section.
 *
 * So a queue item carries the position (`processRun`), the queue sends it
 * inside {@link runInProcessPosition}, and ProcessStateStore answers the role,
 * the process variables and the context block for that position while it is
 * active. A queue item added while a run is active (an agent planning a step
 * queues its todo walks) inherits the position (prompt-queue-tools).
 *
 * `AsyncLocalStorage`, unlike the synchronous stack in tool-execution-context,
 * because a send awaits the whole model turn, tool calls included, and other
 * sends (the chat panel) may run concurrently.
 *
 * vscode-free.
 */

import { AsyncLocalStorage } from 'async_hooks';

import type { ProcessState } from '../utils/processDefinition';

/** The position a queued prompt belongs to: the quest and its process state then. */
export interface ProcessRun {
    quest: string;
    state: ProcessState;
}

const storage = new AsyncLocalStorage<ProcessRun>();

/** Run `fn` as the prompt of `run`; without `run`, just run it. */
export function runInProcessPosition<T>(run: ProcessRun | undefined, fn: () => Promise<T>): Promise<T> {
    return run ? storage.run(run, fn) : fn();
}

/** The position the current send runs for, if any. */
export function currentProcessRun(): ProcessRun | undefined {
    return storage.getStore();
}

/**
 * The position a newly queued item belongs to: the one given, else the one
 * the current send runs for (a running Proceed prompt queuing its todo walks),
 * else none.
 */
export function inheritedProcessRun(explicit: ProcessRun | undefined): ProcessRun | undefined {
    return explicit ?? currentProcessRun();
}

/** A run as stored in the queue file (plain fields); undefined when it is not one. */
export function parseProcessRun(raw: unknown): ProcessRun | undefined {
    if (typeof raw !== 'object' || raw === null) { return undefined; }
    const r = raw as Record<string, unknown>;
    const st = r.state as Record<string, unknown> | undefined;
    if (typeof r.quest !== 'string' || typeof st !== 'object' || st === null || typeof st.process !== 'string') { return undefined; }
    const str = (k: string): string => (typeof st[k] === 'string' ? st[k] as string : '');
    const num = (k: string): number => (Number.isInteger(st[k]) && (st[k] as number) >= 1 ? st[k] as number : 1);
    return {
        quest: r.quest,
        state: {
            process: str('process'), phase: str('phase'), phaseIteration: num('phaseIteration'),
            step: str('step'), stepIteration: num('stepIteration'),
            substep: str('substep'), substepIteration: num('substepIteration'),
            completed: false,
        },
    };
}
