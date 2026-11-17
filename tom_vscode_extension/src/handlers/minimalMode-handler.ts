/**
 * Placeholder panels while the extension does not start its normal parts.
 *
 * Two modes, every webview view of package.json gets the placeholder:
 *
 *   - **setup** (no `.tom/` configuration folder): a "not a TOM AI workspace"
 *     message with setup instructions;
 *   - **format** (the `_ai` files are not in this build's format,
 *     vscimpb142a): the hint of {@link formatEmergencyHint} with
 *     **Upgrade the workspace…** (the migration page) or, for files newer than
 *     the build, the build to install; once migrated, **Reload window**.
 *
 * Extends {@link BaseWebviewProvider} for the common webview boilerplate.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BaseWebviewProvider } from '../utils/baseWebviewProvider';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { SETUP_WORKSPACE_COMMAND } from '../utils/setupCommandIds';
import type { FormatEmergencyHint } from '../utils/aiFormatMigrationRun';

/** The command the format hint's button runs (aiFormatMigration-handler.ts, kept here to avoid a cycle). */
const MIGRATE_AI_FORMATS_COMMAND = 'tomAi.migrateAiFormats';

/** Used when package.json cannot be read. */
const FALLBACK_VIEW_IDS = [
    'tomAi.chatPanel',
    'tomAi.wsPanel',
    'tomAi.vscodeNotes',
    'tomAi.process',
    'tomAi.questNotes',
    'tomAi.questTodos',
    'tomAi.sessions',
    'tomAi.sessionTodos',
    'tomAi.todoLog',
    'tomAi.workspaceNotes',
    'tomAi.workspaceTodos',
];

/** Every webview view package.json contributes (a placeholder for each, so none spins forever). */
export function minimalViewIds(packageJson: unknown): string[] {
    const views = (packageJson as { contributes?: { views?: Record<string, Array<{ id?: string; type?: string }>> } })?.contributes?.views;
    if (!views) { return [...FALLBACK_VIEW_IDS]; }
    const ids: string[] = [];
    for (const list of Object.values(views)) {
        for (const v of list ?? []) {
            if (v.id && v.type === 'webview' && !ids.includes(v.id)) { ids.push(v.id); }
        }
    }
    return ids.length ? ids : [...FALLBACK_VIEW_IDS];
}

/** What the placeholders show. */
export type MinimalModeContent = { mode: 'setup' } | { mode: 'format'; hint: FormatEmergencyHint };

class MinimalModeViewProvider extends BaseWebviewProvider {
    private readonly webviews = new Set<vscode.Webview>();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private content: MinimalModeContent,
    ) {
        super();
        this.registerMessageHandler('openSetupDoc', async () => {
            await this._openSetupDoc();
        });
        this.registerMessageHandler('setupWorkspaceFolder', async () => {
            await vscode.commands.executeCommand(SETUP_WORKSPACE_COMMAND);
        });
        this.registerMessageHandler('upgradeWorkspace', async () => {
            await vscode.commands.executeCommand(MIGRATE_AI_FORMATS_COMMAND);
        });
        this.registerMessageHandler('reload', async () => {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
    }

    protected onResolve(webview: vscode.Webview): void {
        webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
            ],
        };
        this.webviews.add(webview);
        webview.html = loadWebviewHtml(webview, 'minimalMode', { init: this.content as unknown as Record<string, unknown> });
        const view = this.view;
        if (typeof view?.onDidDispose === 'function') { view.onDidDispose(() => this.webviews.delete(webview)); }
    }

    /** Show `content` in every resolved placeholder. */
    update(content: MinimalModeContent): void {
        this.content = content;
        for (const webview of this.webviews) {
            void webview.postMessage?.({ type: 'content', content });
        }
    }

    private async _openSetupDoc(): Promise<void> {
        // Try to open the bundled workspace_setup.md via the markdown preview
        const docPath = path.join(this._extensionUri.fsPath, 'doc', 'workspace_setup.md');
        if (fs.existsSync(docPath)) {
            const doc = await vscode.workspace.openTextDocument(docPath);
            await vscode.window.showTextDocument(doc, { preview: true });
        } else {
            vscode.window.showInformationMessage(
                'Setup instructions: create a .tom/ folder in your workspace root, then reload the window.',
            );
        }
    }
}

/** The placeholders, to change what they show (format mode: once migrated). */
export interface MinimalModePanels {
    update(content: MinimalModeContent): void;
}

/**
 * Register placeholder webview providers for every panel view ID.
 * This prevents the "loading" spinner from showing indefinitely.
 */
export function registerMinimalModePanels(context: vscode.ExtensionContext, content: MinimalModeContent = { mode: 'setup' }): MinimalModePanels {
    const provider = new MinimalModeViewProvider(context.extensionUri, content);
    for (const viewId of minimalViewIds(context.extension?.packageJSON)) {
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(viewId, provider),
        );
    }
    // Tie the provider's lifetime to the extension so disposables clear.
    context.subscriptions.push(provider);
    return provider;
}
