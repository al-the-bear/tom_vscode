/**
 * Completion wiring — the extension-host glue for the shared webview
 * completion client (`media/shared/completion.js`).
 *
 * The webview component posts `{ type: 'requestCompletion', kind, query }`
 * when the user triggers `/skill` / `@file` completion (Ctrl+Shift+Space in a
 * `data-completion="on"` textarea). This helper shows the picker and posts the
 * chosen insertion back as `{ type: 'insertCompletion', text }`; the webview
 * splices it over the trigger token (it tracks the target textarea + range
 * locally, so no element identity travels over the message channel).
 *
 * Registering this on a webview is the *only* wiring a panel needs to enable
 * completion — it adds its own `onDidReceiveMessage` listener that coexists
 * with whatever message switch the panel already has.
 */

import * as vscode from 'vscode';

import { showCompletionPicker } from '../handlers/completion-picker';
import { type CompletionKind } from '../services/completion-service';

/** A request from the webview to open the completion picker. */
interface RequestCompletionMessage {
    type: 'requestCompletion';
    /** `'skill'` (`/`) or `'file'` (`@`); anything else falls back to skill. */
    kind?: string;
    /** Text typed after the trigger char (the filter query). */
    query?: string;
}

function isRequestCompletion(message: unknown): message is RequestCompletionMessage {
    return (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'requestCompletion'
    );
}

/**
 * Wire `requestCompletion` → picker → `insertCompletion` for a webview. Returns
 * the listener `Disposable`; add it to the owning subscriptions if the webview
 * outlives the registration site.
 */
export function wireCompletionMessages(webview: vscode.Webview): vscode.Disposable {
    return webview.onDidReceiveMessage(async (message: unknown) => {
        if (!isRequestCompletion(message)) { return; }
        const kind: CompletionKind = message.kind === 'file' ? 'file' : 'skill';
        const query = String(message.query ?? '');
        await showCompletionPicker(kind, query, (insertText) => {
            void webview.postMessage({ type: 'insertCompletion', text: insertText });
        });
    });
}
