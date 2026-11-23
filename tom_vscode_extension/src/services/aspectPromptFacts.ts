/**
 * The prompt facts an aspect condition reads (gsel20; guideline_sectioning.md
 * D-25): `prompt.transport`, `prompt.kind`, `prompt.todo`, `prompt.role`,
 * `prompt.roleType`, `prompt.run`, `prompt.process`, `prompt.quest`,
 * `prompt.workspace` and `prompt.night`, beside the chat variables and every
 * placeholder `${name}` resolves.
 *
 * {@link livePromptFacts} reads them for the send the code runs in: the queue
 * stage's context when there is one (services/queueRoleContext.ts), else a
 * chat send of this window. A fact that cannot be read is `''`.
 */

import * as path from 'path';
import type { AspectTransport } from '../utils/aspectGuidelines';
import type { QueueRoleSource } from '../utils/promptRole';

/** The kinds of prompt a condition can tell apart. */
export const PROMPT_KINDS = ['chat', 'queue', 'todo', 'proceed', 'timed'] as const;
export type PromptKind = typeof PROMPT_KINDS[number];

/** The facts, by their variable name (`prompt.transport`, …). */
export type AspectPromptFacts = Record<`prompt.${'transport' | 'kind' | 'todo' | 'role' | 'roleType' | 'run' | 'process' | 'quest' | 'workspace' | 'night'}`, string>;

/** The facts with every value `''` but those given. */
export function promptFacts(given: Partial<Record<keyof AspectPromptFacts, string>> = {}): AspectPromptFacts {
    return {
        'prompt.transport': '', 'prompt.kind': '', 'prompt.todo': '', 'prompt.role': '', 'prompt.roleType': '',
        'prompt.run': '', 'prompt.process': '', 'prompt.quest': '', 'prompt.workspace': '', 'prompt.night': '',
        ...given,
    };
}

function attempt<T>(read: () => T): T | undefined {
    try { return read(); } catch { return undefined; }
}

/* eslint-disable @typescript-eslint/no-require-imports */
/** The facts of the send the code runs in, on `transport`. */
export function livePromptFacts(transport: AspectTransport | string, queued?: QueueRoleSource): AspectPromptFacts {
    const { currentQueueRole, livePromptRole } = require('./queueRoleContext') as typeof import('./queueRoleContext');
    const stage = queued ?? currentQueueRole();
    const role = attempt(() => livePromptRole(stage).role) ?? '';
    const { WsPaths } = require('../utils/workspacePaths') as typeof import('../utils/workspacePaths');
    const roleType = role ? attempt(() => {
        const { resolveRoleGuidelines } = require('../utils/roleTypes') as typeof import('../utils/roleTypes');
        const ai = WsPaths.aiRoot;
        return ai ? resolveRoleGuidelines(ai, role).roleType : undefined;
    }) ?? '' : '';
    const store = attempt(() => (require('../managers/processStateStore') as typeof import('../managers/processStateStore')).ProcessStateStore.instance);
    const run = stage?.run ?? store?.currentRun ?? '';
    const proc = run && store ? attempt(() => store.runOverview(run).process) ?? '' : '';
    const layout = attempt(() => (require('../utils/workspaceLayout') as typeof import('../utils/workspaceLayout')).getLayout());
    return promptFacts({
        'prompt.transport': String(transport),
        'prompt.kind': stage ? (stage.kind ?? 'queue') : 'chat',
        'prompt.todo': stage?.todoId ?? '',
        'prompt.role': role,
        'prompt.roleType': roleType,
        'prompt.run': run,
        'prompt.process': proc,
        'prompt.quest': attempt(() => WsPaths.getWorkspaceQuestId()) ?? '',
        'prompt.workspace': layout ? path.basename(layout.workspaceFolder) : '',
    });
}
/* eslint-enable @typescript-eslint/no-require-imports */
