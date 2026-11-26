/**
 * The Recent prompts panel (`@T: Recent Prompts`, `tomAi.editor.recentPrompts`;
 * also the button on top of the Prompt Queue editor): the last
 * {@link RECENT_PROMPTS_LIMIT} prompts the prompt queue sent in this window's
 * quest, one row per item, newest first. Read-only: the queue editor acts on
 * the items.
 *
 * The rows come from the queue's items (utils/recentPrompts.ts: sent and
 * sending items with their stages, the sent history the queue keeps, the chat
 * sends shown in it), with the todos' titles from the quest's todo files and
 * the profiles' names from the configuration. The page redraws on every change
 * of the queue and keeps what the user expanded; Markdown shows a prompt or an
 * answer in the shared Markdown overlay (`media/shared/mdOverlay.js`), rendered
 * here by renderQuestLogMarkdown. Page: `media/recentPromptsPanel/`.
 */

import * as vscode from 'vscode';

import { reportException, loadSendToChatConfig } from './handler_shared.js';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { renderQuestLogMarkdown } from '../utils/questLogMarkdown';
import { getQueueFolder } from '../storage/queueFileStorage';
import { readSentText } from '../utils/sentPrompts';
import { collectRecentPrompts, RECENT_PROMPTS_LIMIT, type RecentPromptLookups, type RecentPromptSourceItem } from '../utils/recentPrompts';
import { WsPaths } from '../utils/workspacePaths';
import { ALL_TODO_FILES } from '../utils/todoArchiveNames';
import { PromptQueueManager } from '../managers/promptQueueManager';
import { readAllTodos } from '../managers/questTodoManager';

export const RECENT_PROMPTS_COMMAND = 'tomAi.editor.recentPrompts';
export const RECENT_PROMPTS_VIEW_TYPE = 'tomAi.recentPrompts';

let panel: vscode.WebviewPanel | undefined;
let queueListener: vscode.Disposable | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined;

/** The todo titles and profile names the rows show. */
function lookups(): RecentPromptLookups {
    const titles = new Map<string, string>();
    try {
        const quest = WsPaths.getWorkspaceQuestId();
        if (quest && quest !== 'default') {
            for (const t of readAllTodos(quest, ALL_TODO_FILES)) {
                if (t.id && t.title && !titles.has(t.id)) { titles.set(t.id, t.title); }
            }
        }
    } catch { /* no todo files: ids only */ }
    const profiles = new Map<string, string>();
    try {
        for (const p of loadSendToChatConfig()?.anthropic?.profiles ?? []) {
            if (p && typeof p.id === 'string' && p.name) { profiles.set(p.id, p.name); }
        }
    } catch { /* no configuration: ids only */ }
    return { todoTitle: (id) => titles.get(id), profileName: (id) => profiles.get(id) };
}

/** The page's state: the rows of the last prompts sent. */
export function recentPromptsState(items: readonly RecentPromptSourceItem[], look: RecentPromptLookups = lookups()): Record<string, unknown> {
    const { rows, promptCount, truncated } = collectRecentPrompts(items, look);
    return { type: 'state', rows, promptCount, truncated, limit: RECENT_PROMPTS_LIMIT };
}

function queueItems(): readonly RecentPromptSourceItem[] {
    try { return PromptQueueManager.instance.items; } catch { return []; }
}

function post(): void {
    if (!panel) { return; }
    try {
        void panel.webview.postMessage(recentPromptsState(queueItems()));
    } catch (error) {
        reportException('recentPrompts.post', error);
    }
}

function soon(): void {
    if (debounce) { clearTimeout(debounce); }
    debounce = setTimeout(() => { debounce = undefined; post(); }, 300);
}

function webviewOptions(ctx: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(ctx.extensionUri, 'media'),
            vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
    };
}

function onMessage(msg: { type?: string; title?: string; markdown?: string; ref?: string }): void {
    try {
        if (msg?.type === 'ready') { post(); return; }
        if (msg?.type === 'renderMarkdown') {
            void panel?.webview.postMessage({ type: 'markdownHtml', title: String(msg.title || ''), html: renderQuestLogMarkdown(String(msg.markdown || '')) });
        }
        if (msg?.type === 'showSentText') {
            // A stage's user message or system prompt as sent (utils/sentPrompts.ts), shown as Markdown.
            const folder = getQueueFolder();
            const text = folder && msg.ref ? readSentText(folder, String(msg.ref)) : undefined;
            const markdown = text ?? '_This text is no longer kept (the store keeps the texts the queue\'s items still name)._';
            void panel?.webview.postMessage({ type: 'markdownHtml', title: String(msg.title || ''), html: renderQuestLogMarkdown(markdown) });
        }
    } catch (error) {
        reportException('recentPrompts.onMessage', error, { type: msg?.type });
    }
}

/** Wire a fresh or reload-restored panel: the page, its messages, the queue's changes. */
function bind(ctx: vscode.ExtensionContext, p: vscode.WebviewPanel): void {
    panel = p;
    const codicons = p.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    p.webview.onDidReceiveMessage(onMessage);
    p.webview.html = loadWebviewHtml(p.webview, 'recentPromptsPanel', { init: { codiconsUri: codicons.toString(), state: recentPromptsState(queueItems()) } });
    // Through whenReady: a tab restored after a reload is bound before the queue manager starts.
    void PromptQueueManager.whenReady().then((qm) => {
        if (panel !== p || queueListener) { return; }
        queueListener = qm.onDidChange(() => soon());
        post();
    });
    p.onDidDispose(() => {
        if (panel === p) { panel = undefined; }
        queueListener?.dispose();
        queueListener = undefined;
        if (debounce) { clearTimeout(debounce); debounce = undefined; }
    });
}

/** Open the panel, or bring it to the front. */
export function openRecentPromptsPanel(ctx: vscode.ExtensionContext): void {
    if (panel) { panel.reveal(); post(); return; }
    const p = vscode.window.createWebviewPanel(RECENT_PROMPTS_VIEW_TYPE, 'Recent Prompts', vscode.ViewColumn.Active, { ...webviewOptions(ctx), retainContextWhenHidden: true });
    bind(ctx, p);
}

/** The command and the reload serializer. */
export function registerRecentPromptsPanel(ctx: vscode.ExtensionContext): void {
    ctx.subscriptions.push(vscode.commands.registerCommand(RECENT_PROMPTS_COMMAND, () => openRecentPromptsPanel(ctx)));
    ctx.subscriptions.push(vscode.window.registerWebviewPanelSerializer(RECENT_PROMPTS_VIEW_TYPE, {
        async deserializeWebviewPanel(p: vscode.WebviewPanel): Promise<void> {
            if (panel) { p.dispose(); return; }
            p.webview.options = webviewOptions(ctx);
            bind(ctx, p);
        },
    }));
}
