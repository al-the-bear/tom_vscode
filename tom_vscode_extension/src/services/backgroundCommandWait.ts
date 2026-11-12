/**
 * The direct API and Local LLM transports' background wait: when a queue
 * turn ends while `tomAi_runCommandStream` handles it started still run, the
 * turn waits for them by the rules of utils/backgroundWait.ts — alive while
 * their process group exists, at most the limit. When they have ended, the
 * transport gives the model {@link commandsFinishedMessage} and the turn goes
 * on, as the Agent SDK's CLI runs a follow-up turn on a task's completion; at
 * the limit the turn ends with the still-running hint.
 *
 * Pure: the process list, the clock and the sleep are passed in.
 */

import type { OwnedCommand } from '../tools/process-tools';
import type { BackgroundWaitState, BackgroundWorkItem } from '../utils/backgroundWait';

export type CommandWaitOutcome =
    /** Nothing of the send's was running. */
    | { kind: 'none' }
    /** Everything waited for has ended (their final state). */
    | { kind: 'finished'; commands: OwnedCommand[] }
    /** The limit was reached (or waiting is off, limit 0) with these still running. */
    | { kind: 'limit'; running: BackgroundWorkItem[] }
    /** The send was cancelled while waiting. */
    | { kind: 'cancelled' };

export interface CommandWaitDeps {
    /** The send's command streams, as now. */
    list(): OwnedCommand[];
    now(): number;
    sleep(ms: number): Promise<void>;
    isCancelled(): boolean;
    /** The waiting state while waiting, `undefined` once the wait is over. */
    onState?(state: BackgroundWaitState | undefined): void;
    /** Poll interval. Default 2 s. */
    pollMs?: number;
}

function workItem(c: OwnedCommand): BackgroundWorkItem {
    return { id: c.handle, kind: 'command', description: c.command, command: c.command };
}

/** Wait for the send's running command streams; see {@link CommandWaitOutcome}. */
export async function waitForOwnedCommands(limitMinutes: number, deps: CommandWaitDeps): Promise<CommandWaitOutcome> {
    const first = deps.list().filter((c) => c.running);
    if (first.length === 0) { return { kind: 'none' }; }
    if (limitMinutes <= 0) { return { kind: 'limit', running: first.map(workItem) }; }
    const handles = new Set(first.map((c) => c.handle));
    const since = deps.now();
    const limitMs = limitMinutes * 60_000;
    const stateOf = (running: OwnedCommand[]): BackgroundWaitState => ({
        since: new Date(since).toISOString(),
        limitMinutes,
        items: running.map(workItem),
    });
    let shown = [...handles].join(',');
    deps.onState?.(stateOf(first));
    try {
        for (;;) {
            await deps.sleep(deps.pollMs ?? 2_000);
            if (deps.isCancelled()) { return { kind: 'cancelled' }; }
            const mine = deps.list().filter((c) => handles.has(c.handle));
            const running = mine.filter((c) => c.running);
            if (running.length === 0) { return { kind: 'finished', commands: mine }; }
            if (deps.now() - since >= limitMs) { return { kind: 'limit', running: running.map(workItem) }; }
            const key = running.map((c) => c.handle).join(',');
            if (key !== shown) {
                shown = key;
                deps.onState?.(stateOf(running));
            }
        }
    } finally {
        deps.onState?.(undefined);
    }
}

/** The user message the turn goes on with once the commands it waited for have ended. */
export function commandsFinishedMessage(commands: readonly OwnedCommand[]): string {
    const lines = commands.map((c) => {
        const end = c.signal ? `ended by ${c.signal}` : `exit code ${c.exitCode ?? 'unknown'}`;
        return `- \`${c.command}\` [${c.handle}]: ${end}`;
    });
    return [
        `The background command${commands.length === 1 ? '' : 's'} you started ${commands.length === 1 ? 'has' : 'have'} finished:`,
        ...lines,
        'Read the output with tomAi_readCommandOutput (since: "all") and finish the work you were waiting for.',
    ].join('\n');
}
