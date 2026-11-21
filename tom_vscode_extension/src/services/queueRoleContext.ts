/**
 * The role a queue stage runs as, while it runs (gsel3; utils/promptRole.ts
 * has the order).
 *
 * The prompt queue expands and sends each stage of an item inside
 * {@link runWithQueueRole} with the roles it knows for that stage: the todo it
 * runs (a walk iteration's or a TODO item's, from its main prompt on), the
 * item's own `role` and its run's queue default. {@link livePromptRole} is the
 * one place every reader asks — the tools a send gets (services/roleTools.ts),
 * `${role}` and `${role-description}` (utils/variableResolver.ts) and the spec
 * tools — so the tools, the placeholders and the role text always agree.
 *
 * `AsyncLocalStorage` like processRunContext: the lanes of several runs send
 * at the same time.
 */

import { AsyncLocalStorage } from 'async_hooks';

import { effectivePromptRole, type PromptRole, type QueueRoleSource } from '../utils/promptRole';

const storage = new AsyncLocalStorage<QueueRoleSource>();

/** Run `fn` as a queue stage with `source`'s roles; without `source`, just run it. */
export function runWithQueueRole<T>(source: QueueRoleSource | undefined, fn: () => Promise<T>): Promise<T> {
    return source ? storage.run(source, fn) : fn();
}

/** The queue stage's roles the current code runs with, if any. */
export function currentQueueRole(): QueueRoleSource | undefined {
    return storage.getStore();
}

/** Tests: the step role and the chat variable `livePromptRole` reads (undefined: the live ones). */
let testDeps: { stepRole(): string | undefined; chatRole(): string | undefined } | undefined;
export function __setPromptRoleDepsForTests(deps: typeof testDeps): void { testDeps = deps; }

/**
 * The role the current send runs as: the queue stage's todo or item role, the
 * running Proceed's step role, the run's default role, else the chat variable
 * `role`. `queued`: the queue stage's roles (default: the stage the current
 * code runs in).
 */
export function livePromptRole(queued: QueueRoleSource | undefined = currentQueueRole()): PromptRole {
    let stepRole: string | undefined;
    let chatRole: string | undefined;
    if (testDeps) {
        stepRole = testDeps.stepRole();
        chatRole = testDeps.chatRole();
    } else {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            stepRole = (require('../managers/processStateStore') as typeof import('../managers/processStateStore')).ProcessStateStore.instance?.runRole();
        } catch { /* no process store */ }
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            chatRole = (require('../managers/chatVariablesStore') as typeof import('../managers/chatVariablesStore')).ChatVariablesStore.instance?.role;
        } catch { /* no chat variables */ }
    }
    return effectivePromptRole({ queued, stepRole, chatRole });
}
