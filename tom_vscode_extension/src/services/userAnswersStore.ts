/**
 * This window's view of the answer store (utils/userAnswers.ts, vscimpb171):
 * where the store is — a folder of the extension's global storage, keyed by
 * the real `_ai` folder, registered at activation — and who is told when this
 * window stored an answer (the Answers page, the notification, the over-limit
 * notice).
 *
 * vscode-free.
 */

import { answersStoreDir, type UserAnswer } from '../utils/userAnswers';

let globalStorage: string | undefined;
let aiRootOf: (() => string | undefined) | undefined;
const listeners = new Set<(answer: UserAnswer) => void>();

/** Register the extension's global storage folder and how the window's `_ai` root is read (activation). */
export function configureAnswersStore(storage: string | undefined, aiRoot: (() => string | undefined) | undefined): void {
    globalStorage = storage;
    aiRootOf = aiRoot;
}

/** The store's folder for this window's `_ai`; undefined before activation or without an `_ai` root. */
export function answersDir(): string | undefined {
    const ai = aiRootOf?.();
    return globalStorage && ai ? answersStoreDir(globalStorage, ai) : undefined;
}

/** Be told when this window stored an answer; answers the unsubscribe. */
export function onAnswerStored(listener: (answer: UserAnswer) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** This window stored `answer`: tell the listeners (none of them may fail the caller). */
export function fireAnswerStored(answer: UserAnswer): void {
    for (const l of [...listeners]) {
        try { l(answer); } catch { /* a listener must not break the tool call */ }
    }
}
