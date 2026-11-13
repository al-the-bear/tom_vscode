/**
 * Documents the extension's own tools wrote (vscimpb66b): the spec and
 * Markdown question tools save through `vscodeSomDocumentIo` — through an
 * open editor and its save, or straight to disk — and say so here, so every
 * MD Browser panel on the file renders it again at once instead of waiting
 * for its file watcher (which an atomic rename does not always wake) or its
 * once-a-second poll.
 *
 * vscode-free.
 */

const listeners = new Set<(absPath: string) => void>();

/** A tool wrote `absPath`: tell the listeners. */
export function notifyDocumentWritten(absPath: string): void {
    for (const l of [...listeners]) {
        try { l(absPath); } catch { /* a listener must not break the write */ }
    }
}

/** Be told when a document is written; answers the unsubscribe. */
export function onDocumentWritten(listener: (absPath: string) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
