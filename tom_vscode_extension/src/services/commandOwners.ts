/**
 * The send a `tomAi_runCommandStream` handle belongs to. Every Anthropic send
 * runs inside {@link runAsCommandOwner}; a command stream started by one of
 * its tool calls records the owner, so the turn can wait for the commands IT
 * started when it ends (utils/backgroundWait.ts) and not for those of another
 * send. An `AsyncLocalStorage` context, as in `services/askOwners.ts`.
 *
 * Pure: imports neither `vscode` nor the tools.
 */

import { AsyncLocalStorage } from 'async_hooks';

const ownerContext = new AsyncLocalStorage<string>();

/** Run `fn` as `owner`: the command streams it starts are that owner's. */
export function runAsCommandOwner<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    return ownerContext.run(owner, fn);
}

/** The send this code runs in, if any. */
export function currentCommandOwner(): string | undefined {
    return ownerContext.getStore();
}
