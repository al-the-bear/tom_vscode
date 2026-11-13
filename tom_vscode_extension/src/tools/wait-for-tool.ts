/**
 * `tomAi_waitFor` — a turn says it waits on something outside it and waits
 * (vscimpb82): pub.dev's 12 new versions of a package in 24 hours, a rate
 * window, a build elsewhere. Blocks until `until` / `minutes`, the user's
 * interrupt (Continue on the queue item), or the end of the prompt.
 *
 * Rules and texts: utils/waitFor.ts; the open waits: services/waitForRegistry.ts.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import { WaitForRegistry } from '../services/waitForRegistry';
import { currentQueueItemId } from '../services/userWaits';
import {
    MAX_WAIT_MINUTES,
    waitCancelledAnswer,
    waitElapsedAnswer,
    waitForState,
    waitInterruptedAnswer,
    type WaitForInput,
} from '../utils/waitFor';

export interface WaitForDeps {
    registry: Pick<WaitForRegistry, 'wait'>;
    now(): number;
    queueItemId(): string | undefined;
}

const LIVE_DEPS: WaitForDeps = {
    registry: { wait: (state, id) => WaitForRegistry.instance.wait(state, id) },
    now: () => Date.now(),
    queueItemId: () => currentQueueItemId(),
};

/** Wait as the input says; answers the tool's JSON. */
export async function waitForImpl(input: WaitForInput, deps: WaitForDeps = LIVE_DEPS): Promise<string> {
    const start = deps.now();
    const parsed = waitForState(input, start);
    if ('error' in parsed) { return JSON.stringify({ ok: false, error: parsed.error }); }
    const queueItemId = deps.queueItemId();
    const outcome = await deps.registry.wait(parsed.state, queueItemId);
    const waited = deps.now() - start;
    if (outcome === 'elapsed') { return waitElapsedAnswer(parsed.state, waited); }
    if (outcome === 'interrupted') { return waitInterruptedAnswer(parsed.state, waited, queueItemId !== undefined); }
    return waitCancelledAnswer(parsed.state);
}

export const WAIT_FOR_DESCRIPTION =
    'Wait on something outside this turn that only time resolves — e.g. pub.dev allows 12 new versions of a package in 24 h, '
    + 'so the next publish waits until the oldest of those is a day old; a rate window; a build elsewhere. Use it instead of '
    + 'ending the turn or sleeping in a shell command. `reason`: one line the user sees on the queue item (say what and why, '
    + 'e.g. "pub.dev limit: 12 versions in 24 h, next publish possible at 14:20"). `until`: an ISO date-time or `HH:MM` '
    + `(local; tomorrow when passed), or \`minutes\`; at most ${MAX_WAIT_MINUTES / 60} h. Optional \`details\`. BLOCKING: the turn and its `
    + 'conversation stay open, and its queue run sends nothing else meanwhile. Answers `{ok, outcome, waited, message}`: '
    + '`elapsed` — go on with the awaited step; `interrupted` — the user moved on: end your turn now with a note of what is '
    + 'still to do and do not do the awaited step (in the queue the item runs again later); `cancelled` — the prompt ended.';

export const WAIT_FOR_TOOL: SharedToolDefinition<WaitForInput> = {
    name: 'tomAi_waitFor',
    displayName: 'Wait For',
    description: WAIT_FOR_DESCRIPTION,
    tags: ['prompt-queue', 'wait', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['reason'],
        properties: {
            reason: { type: 'string', description: 'One line: what the turn waits for and why, shown on the queue item.' },
            until: { type: 'string', description: 'When the wait ends: an ISO date-time, or HH:MM local time (tomorrow when already passed).' },
            minutes: { type: 'number', description: 'Instead of `until`: how many minutes to wait.' },
            details: { type: 'string', description: 'Optional: more about it (shown in the item\'s tooltip).' },
        },
    },
    execute: async (input) => waitForImpl(input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WAIT_FOR_TOOLS: SharedToolDefinition<any>[] = [WAIT_FOR_TOOL];
