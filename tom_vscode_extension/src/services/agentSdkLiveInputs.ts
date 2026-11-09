/**
 * The Agent SDK queries running in this window, by session: what an update to
 * a running prompt is sent into.
 *
 * The transport (runAgentSdkQuery) registers a query's input channel
 * (agent-sdk-input-channel.ts) under its session while the query runs, and
 * removes it when the query ends. A chat send into that session can then go in
 * as another user message of the running conversation (the SDK's streaming
 * input) instead of waiting for it or being queued.
 *
 * Pure: imports neither `vscode` nor the SDK.
 */

import type { PushedMessage } from './agent-sdk-input-channel';

/** What the registry needs of a running query's input. */
export interface LiveQueryInput {
    readonly closed: boolean;
    push(text: string): PushedMessage | undefined;
}

const live = new Map<string, LiveQueryInput>();

/** Register the query running in `session`; answers how to unregister it (only this one). */
export function registerLiveQuery(session: string, input: LiveQueryInput): () => void {
    live.set(session, input);
    return () => { if (live.get(session) === input) { live.delete(session); } };
}

/** Whether a query running in `session` takes updates. */
export function canUpdateRunningPrompt(session: string): boolean {
    const input = live.get(session);
    return !!input && !input.closed;
}

/** Send `text` into the query running in `session`; undefined when none runs there. */
export function sendUpdateToRunningPrompt(session: string, text: string): PushedMessage | undefined {
    const input = live.get(session);
    if (!input || input.closed) { return undefined; }
    return input.push(text);
}
