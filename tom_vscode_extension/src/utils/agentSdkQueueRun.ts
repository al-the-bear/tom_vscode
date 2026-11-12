/**
 * What an Agent SDK queue run changes so its background work stays waitable
 * (utils/backgroundWait.ts): the queue waits for the CLI's background tasks,
 * so everything that would run on outside them is taken away.
 *
 *   - Bash commands that detach from their call (`cmd &`, `nohup`, `setsid`,
 *     …: utils/detachingCommand.ts) are refused by a `PreToolUse` hook. A
 *     hook, not `canUseTool`: the SDK does not ask `canUseTool` at all in
 *     `bypassPermissions`, the mode of a profile that asks for no approval,
 *     and a hook's deny holds in every mode.
 *   - `tomAi_runCommandStream` is not offered, and Claude Code's `Monitor`
 *     is disallowed: `run_in_background` covers both, and the CLI lists it.
 *
 * Chat sends keep all of it. Pure.
 */

import { detachingCommandReason, detachingRefusalMessage } from './detachingCommand';

/** Our tools not offered in an Agent SDK queue run. */
export const QUEUE_RUN_OMITTED_TOOLS: readonly string[] = ['tomAi_runCommandStream'];

/** Claude Code's built-in tools disallowed in an Agent SDK queue run. */
export const QUEUE_RUN_DISALLOWED_BUILT_INS: readonly string[] = ['Monitor'];

/** The tools an Agent SDK queue run offers. */
export function queueRunTools<T extends { name: string }>(tools: readonly T[]): T[] {
    return tools.filter((t) => !QUEUE_RUN_OMITTED_TOOLS.includes(t.name));
}

/** A `PreToolUse` callback as the SDK's `hooks` option takes it. */
export type PreToolUseCallback = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

/**
 * The `PreToolUse` callback (matcher `Bash`) that refuses a detaching command,
 * answering why and what to do instead; anything else passes (`{}`).
 */
export const refuseDetachingBash: PreToolUseCallback = async (input) => {
    const toolInput = input.tool_input as { command?: unknown } | undefined;
    const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
    const reason = detachingCommandReason(command);
    if (!reason) { return {}; }
    return {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- the SDK's hook output
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: detachingRefusalMessage(reason) },
    };
};

type HookMap = Record<string, Array<{ matcher?: string; hooks: PreToolUseCallback[]; timeout?: number }>>;

/** `hooks` with the detach guard added for Bash (the other hooks kept, before it). */
export function withDetachGuard(hooks: Partial<HookMap>): HookMap {
    const out: HookMap = {};
    for (const [event, entries] of Object.entries(hooks)) {
        if (entries) { out[event] = [...entries]; }
    }
    (out.PreToolUse ??= []).push({ matcher: 'Bash', hooks: [refuseDetachingBash] });
    return out;
}
