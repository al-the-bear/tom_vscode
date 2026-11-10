/**
 * Questions belong to the prompt that asked them. An Anthropic send runs
 * inside {@link runAsAskOwner}; every question opened by its tool calls
 * (`tomAi_askUser`, the Agent SDK's `AskUserQuestion`, `tomAi_askInMdBrowser`,
 * the QuickPick and input box of `tomAi_askUserPicker` and of an
 * `AskUserQuestion` without choices — `createLiveUserPrompter`)
 * registers its cancel with {@link registerAskCancel}. When the send ends —
 * answered, stopped, aborted or failed — the questions it left open are
 * cancelled, so no question panel outlives the prompt that asked it.
 *
 * The owner is an `AsyncLocalStorage` context, as in `services/userWaits.ts`:
 * a question asked outside any send (a tool called by an MCP client) has no
 * owner and ends only by its answer, timeout or cancel.
 *
 * Pure: imports neither `vscode` nor the ask tools.
 */

import { AsyncLocalStorage } from 'async_hooks';

interface AskOwner {
    cancels: Set<() => void>;
}

const ownerContext = new AsyncLocalStorage<AskOwner>();

/**
 * Run `fn` as the owner of the questions it asks: those still open when it
 * settles are cancelled then (each cancel at most once; a cancel that throws
 * does not keep the others from running).
 */
export async function runAsAskOwner<T>(fn: () => Promise<T>): Promise<T> {
    const owner: AskOwner = { cancels: new Set() };
    try {
        return await ownerContext.run(owner, fn);
    } finally {
        const left = [...owner.cancels];
        owner.cancels.clear();
        for (const cancel of left) {
            try { cancel(); } catch { /* the others still end */ }
        }
    }
}

/**
 * Register the cancel of a question opened now; answers the function that
 * unregisters it (call it when the question is resolved). Outside any owner
 * nothing is registered.
 */
export function registerAskCancel(cancel: () => void): () => void {
    const owner = ownerContext.getStore();
    if (!owner) { return () => undefined; }
    owner.cancels.add(cancel);
    return () => { owner.cancels.delete(cancel); };
}

/** Whether this code runs inside a send that owns its questions. */
export function hasAskOwner(): boolean {
    return ownerContext.getStore() !== undefined;
}
