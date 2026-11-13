/**
 * A tool call raced against the send's cancellation (vscimpb78): the tool loop
 * of the direct, Local LLM and VS Code LM transports (`runTool`) does not wait
 * for a tool that does not listen to the cancel — a question, an approval, a
 * long poll — once the send is cancelled; the call answers
 * {@link PROMPT_ENDED_TOOL_RESULT} and the turn ends at the next round's check.
 * The tool's own promise is left to settle on its own; its result or error is
 * dropped.
 *
 * vscode-free.
 */

/** The tool result of a call the cancelled send no longer waited for. */
export const PROMPT_ENDED_TOOL_RESULT = 'cancelled: the prompt was ended';

/** The part of a `vscode.CancellationToken` the race reads. */
export interface CancellationLike {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}

export type RaceOutcome<T> = { cancelled: false; value: T } | { cancelled: true };

/**
 * `work`'s value, or `{cancelled: true}` as soon as `cancellation` fires (at
 * once when it has fired already). A rejection of `work` before the cancel
 * rejects; one after it is swallowed.
 */
export function raceCancellation<T>(work: Promise<T>, cancellation?: CancellationLike): Promise<RaceOutcome<T>> {
    if (!cancellation) { return work.then((value) => ({ cancelled: false as const, value })); }
    return new Promise<RaceOutcome<T>>((resolve, reject) => {
        let done = false;
        const finish = (outcome: RaceOutcome<T> | { error: unknown }): void => {
            if (done) { return; }
            done = true;
            listener?.dispose();
            if ('error' in outcome) { reject(outcome.error); } else { resolve(outcome); }
        };
        const listener: { dispose(): void } | undefined = cancellation.isCancellationRequested
            ? undefined
            : cancellation.onCancellationRequested(() => finish({ cancelled: true }));
        if (cancellation.isCancellationRequested) { finish({ cancelled: true }); }
        work.then((value) => finish({ cancelled: false, value }), (error: unknown) => finish({ error }));
    });
}
