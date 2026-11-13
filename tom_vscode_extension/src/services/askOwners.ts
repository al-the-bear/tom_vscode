/**
 * Questions belong to the prompt that asked them. An Anthropic send runs
 * inside {@link runAsAskOwner}; every question opened by its tool calls
 * (`tomAi_askUser`, the Agent SDK's `AskUserQuestion`, `tomAi_askInMdBrowser`,
 * the QuickPick and input box of `tomAi_askUserPicker` and of an
 * `AskUserQuestion` without choices — `createLiveUserPrompter`)
 * registers its cancel with {@link registerAskCancel}. When the send ends —
 * answered, stopped, aborted or failed — the questions it left open are
 * cancelled, so no question panel outlives the prompt that asked it. When the
 * send is cancelled (Stop, the queue's Continue / Resend) they are cancelled
 * at once, not only when it settles — a tool call blocked in a question would
 * otherwise keep the send from settling. The same holds for every other wait
 * that registers (the tool approval, tomAi_exitPlanMode's plan, askCopilot's
 * polling, askBigBrother's request, tomAi_waitFor).
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
    /** The send was cancelled: what registers from now on is cancelled at once. */
    ended: boolean;
}

/** The part of a `vscode.CancellationToken` the owner reads. */
export interface AskOwnerCancellation {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}

function runCancels(owner: AskOwner): void {
    const left = [...owner.cancels];
    owner.cancels.clear();
    for (const cancel of left) {
        try { cancel(); } catch { /* the others still end */ }
    }
}

const ownerContext = new AsyncLocalStorage<AskOwner>();

/**
 * Run `fn` as the owner of the questions it asks: those still open when it
 * settles are cancelled then (each cancel at most once; a cancel that throws
 * does not keep the others from running). With `cancellation`, they are
 * cancelled as soon as it fires, and a question opened after that is
 * cancelled right after it registers.
 */
export async function runAsAskOwner<T>(fn: () => Promise<T>, cancellation?: AskOwnerCancellation): Promise<T> {
    const owner: AskOwner = { cancels: new Set(), ended: false };
    const endNow = (): void => { owner.ended = true; runCancels(owner); };
    const listener = cancellation?.onCancellationRequested(endNow);
    if (cancellation?.isCancellationRequested) { owner.ended = true; }
    try {
        return await ownerContext.run(owner, fn);
    } finally {
        listener?.dispose();
        runCancels(owner);
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
    if (owner.ended) {
        // The send was cancelled already: end the wait once its opener has finished setting it up.
        queueMicrotask(() => { if (owner.cancels.delete(cancel)) { try { cancel(); } catch { /* ended anyway */ } } });
    }
    return () => { owner.cancels.delete(cancel); };
}

/** Whether the send this code runs in was cancelled (false outside any send). */
export function askOwnerEnded(): boolean {
    return ownerContext.getStore()?.ended === true;
}

/** Whether this code runs inside a send that owns its questions. */
export function hasAskOwner(): boolean {
    return ownerContext.getStore() !== undefined;
}
