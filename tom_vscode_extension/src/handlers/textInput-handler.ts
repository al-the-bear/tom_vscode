/**
 * A multi-line text input, which VS Code's own input box is not: a panel with
 * a title, a hint, an optional read-only context (e.g. the prompt the text is
 * added to), a textarea and OK / Cancel. Resolves with the text on OK, with
 * undefined on Cancel, Escape or closing the panel.
 *
 * Assets: `media/textInput/`.
 */

import * as vscode from 'vscode';
import * as path from 'path';

import { getExtensionPath } from './handler_shared';
import { loadWebviewHtml } from '../utils/webviewLoader';

export interface MultilineInputOptions {
    /** The panel's title and heading. */
    title: string;
    /** A line under the heading saying what to type. */
    prompt?: string;
    /** The text the box starts with. */
    value?: string;
    placeholder?: string;
    /** The OK button's label. Default `OK`. */
    okLabel?: string;
    /** Read-only text shown above the box, with its label. */
    context?: string;
    contextLabel?: string;
}

/** Ask for a multi-line text; undefined when the user cancels. */
export function showMultilineInput(options: MultilineInputOptions): Promise<string | undefined> {
    const extPath = getExtensionPath();
    const panel = vscode.window.createWebviewPanel(
        'tomAiTextInput',
        options.title,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
            enableScripts: true,
            localResourceRoots: extPath ? [vscode.Uri.file(path.join(extPath, 'media'))] : undefined,
        },
    );
    return new Promise((resolve) => {
        let settled = false;
        const settle = (value: string | undefined): void => {
            if (settled) { return; }
            settled = true;
            resolve(value);
            panel.dispose();
        };
        panel.webview.onDidReceiveMessage((msg: { type?: string; text?: unknown }) => {
            if (msg?.type === 'ok') { settle(typeof msg.text === 'string' ? msg.text : ''); }
            if (msg?.type === 'cancel') { settle(undefined); }
        });
        panel.onDidDispose(() => settle(undefined));
        panel.webview.html = loadWebviewHtml(panel.webview, 'textInput', { init: { ...options } });
    });
}
