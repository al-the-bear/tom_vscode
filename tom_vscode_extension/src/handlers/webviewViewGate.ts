/**
 * The gate in front of every webview view of the extension (vscimpb142d).
 * Each view is registered through {@link registerGatedWebviewViewProvider};
 * normally the gate only remembers the views and hands every resolve to the
 * view's own provider. Closed ({@link closeWebviewViews}, after another window
 * migrated the workspace's `_ai` files under this one), every view — the ones
 * shown and the ones resolved later — shows the placeholder of the minimal
 * mode (media/minimalMode) with what the window needs: "The workspace has been
 * migrated to version X; reload this window." with **Show running prompts**
 * (the reload overlay) and **Reload window**. The view's own provider stays
 * registered but is no longer shown; a provider that writes its HTML again is
 * overwritten (on becoming visible, and on a short check).
 */

import * as vscode from 'vscode';

import { loadWebviewHtml } from '../utils/webviewLoader';
import type { MinimalModeContent } from './minimalMode-handler';

/** What the closed gate's buttons do. */
export interface WebviewGateActions {
    reload(): void;
    showOverlay(): void;
}

const views = new Set<vscode.WebviewView>();
const listening = new WeakSet<vscode.Webview>();
const shown = new WeakMap<vscode.Webview, string>();
let gate: { content: MinimalModeContent; extensionUri: vscode.Uri; actions: WebviewGateActions } | undefined;
let recheck: ReturnType<typeof setInterval> | undefined;

/** The views resolved so far (tests). */
export function gatedViews(): ReadonlySet<vscode.WebviewView> {
    return views;
}

/** Whether the gate is closed. */
export function isWebviewGateClosed(): boolean {
    return !!gate;
}

function render(view: vscode.WebviewView): void {
    if (!gate) { return; }
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(gate.extensionUri, 'media')] };
    const html = loadWebviewHtml(webview, 'minimalMode', { init: gate.content as unknown as Record<string, unknown> });
    webview.html = html;
    shown.set(webview, html);
    if (!listening.has(webview)) {
        listening.add(webview);
        webview.onDidReceiveMessage((msg: { type?: string }) => {
            if (!gate) { return; }
            if (msg?.type === 'tomGate.reload') { gate.actions.reload(); }
            if (msg?.type === 'tomGate.showOverlay') { gate.actions.showOverlay(); }
        });
    }
}

/** Register `provider` for `viewId` behind the gate. */
export function registerGatedWebviewViewProvider(
    viewId: string,
    provider: vscode.WebviewViewProvider,
    options?: { readonly webviewOptions?: { readonly retainContextWhenHidden?: boolean } },
): vscode.Disposable {
    const gated: vscode.WebviewViewProvider = {
        resolveWebviewView(view, context, token) {
            views.add(view);
            if (typeof view.onDidDispose === 'function') { view.onDidDispose(() => views.delete(view)); }
            if (typeof view.onDidChangeVisibility === 'function') {
                view.onDidChangeVisibility(() => { if (gate && view.visible) { render(view); } });
            }
            if (gate) { render(view); return; }
            return provider.resolveWebviewView(view, context, token);
        },
    };
    return vscode.window.registerWebviewViewProvider(viewId, gated, options);
}

/**
 * Close the gate: every view shows `content` (the minimal mode's placeholder) from now on, until the window
 * reloads. Called again it shows the new content.
 */
export function closeWebviewViews(extensionUri: vscode.Uri, content: MinimalModeContent, actions: WebviewGateActions): void {
    gate = { content, extensionUri, actions };
    for (const view of views) { render(view); }
    if (!recheck) {
        // A provider that writes its own HTML again (a refresh) is overwritten.
        recheck = setInterval(() => {
            for (const view of views) {
                if (gate && shown.get(view.webview) !== view.webview.html) { render(view); }
            }
        }, 2000);
    }
}

/** Open the gate again (tests). */
export function resetWebviewGateForTests(): void {
    gate = undefined;
    if (recheck) { clearInterval(recheck); recheck = undefined; }
    views.clear();
}
