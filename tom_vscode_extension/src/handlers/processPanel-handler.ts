/**
 * PROCESS — the @TOM sidebar view showing where the active quest is in its
 * process: process, phase, step and sub-step (dropdowns), their iterations
 * (− / +), the role the step names, the post-gate todos, and each one's
 * description behind a `?` button. Usually the agent moves the state
 * (`tomAi_setProcessState`); the view lets the user see it at a glance and set
 * it by hand. Everything goes through ProcessStateStore, which keeps the
 * quest's state file.
 *
 * View: `tomAi.process` (between VS CODE NOTES and QUEST NOTES).
 * Assets: `media/processPanel/`.
 */

import * as vscode from 'vscode';

import { ProcessStateStore } from '../managers/processStateStore';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { loadWebviewHtml } from '../utils/webviewLoader';
import type { ProcessChange, ProcessLevel } from '../utils/processDefinition';
import { openMarkdownBrowser } from './markdownBrowser-handler';
import { openProcessEditor } from './processEditor-handler';

export const PROCESS_VIEW_ID = 'tomAi.process';

class ProcessViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private subscription?: vscode.Disposable;

    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        const extensionUri = this.context.extensionUri;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'media'),
                vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                vscode.Uri.joinPath(extensionUri, 'node_modules', 'marked', 'lib'),
            ],
        };
        const asUri = (...parts: string[]): string => webviewView.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts)).toString();
        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'processPanel', {
            init: {
                codiconsUri: asUri('node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
                markedUri: asUri('node_modules', 'marked', 'lib', 'marked.umd.js'),
            },
        });
        webviewView.webview.onDidReceiveMessage((msg) => void this.handle(msg), undefined, this.context.subscriptions);
        webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { this.send(); } });
        webviewView.onDidDispose(() => { this.subscription?.dispose(); this.view = undefined; });
        void ProcessStateStore.ready.then((store) => {
            this.subscription?.dispose();
            this.subscription = store.onDidChange(() => this.send());
            this.send();
        });
    }

    private send(): void {
        const store = ProcessStateStore.instance;
        if (!this.view || !store) { return; }
        let chatRole = '';
        try { chatRole = ChatVariablesStore.instance.role; } catch { /* not initialised */ }
        const state = store.state;
        const entry = store.entry(state.process);
        void this.view.webview.postMessage({
            type: 'state',
            quest: store.activeQuest,
            processes: store.list().map((e) => ({ id: e.id, name: e.definition?.name || e.id, valid: !!e.definition })),
            state,
            definition: entry?.definition ?? null,
            processInvalid: !!entry && !entry.definition,
            description: entry?.description ?? '',
            stepRole: store.currentRole(),
            chatRole,
        });
    }

    private report(result: { ok: boolean; error?: string }): void {
        if (!result.ok && result.error) { void vscode.window.showWarningMessage(`Process: ${result.error}`); }
        this.send();
    }

    private async handle(msg: { type: string; change?: ProcessChange; level?: ProcessLevel; delta?: number; id?: string }): Promise<void> {
        const store = await ProcessStateStore.ready;
        switch (msg.type) {
            case 'ready':
                this.send();
                break;
            case 'change':
                if (msg.change) { this.report(store.apply(msg.change, 'user')); }
                break;
            case 'iteration':
                if (msg.level && msg.delta) { this.report(store.stepIteration(msg.level, msg.delta, 'user')); }
                break;
            case 'openEditor':
                openProcessEditor(this.context, msg.id || store.state.process || undefined);
                break;
            case 'openDescriptionFile': {
                const entry = store.entry(msg.id || store.state.process);
                if (entry) { openMarkdownBrowser(this.context, entry.mdPath); }
                break;
            }
        }
    }
}

/** Register the PROCESS view. The process editor is registered by processEditor-handler. */
export function registerProcessView(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(PROCESS_VIEW_ID, new ProcessViewProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );
}
