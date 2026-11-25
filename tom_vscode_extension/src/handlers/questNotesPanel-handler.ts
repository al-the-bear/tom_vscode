/**
 * QUEST NOTES side panel (vscimpb101): an activity-bar container of its own
 * (`tomAi-info-sidebar`, @TOM INFO) beside @TOM, @TOM WS and @TOM VSC, holding
 * one webview view, `tomAi.questNotesPanel`, on the active quest's notes
 * files (`_ai/quests/<quest>/notes/*.md`; `quest-notes.md`, named by
 * `tomAi.notes.questNotesPattern`, is the default).
 *
 * Its page (media/questNotesPanel/) has a picker of the notes files with a
 * New notes file button, and two tabs on the file picked: **Edit**, a text
 * area on the file, and **View**, the file rendered by the MD Browser's own
 * scripts (media/markdownBrowser/blocks.js, teamReview.js, main.js) —
 * headings, folding, links, review annotations shown read-only. Buttons open
 * the file in the MD Browser and in an editor.
 *
 * Which file is shown, the list and the picker's messages are the
 * `QuestNotesSession`'s (notepad/questNotesSession.ts), the same host logic
 * the @TOM QUEST NOTES view uses (sidebarNotes-handler.ts): one choice per
 * window and quest for both views. The file is read and written through the
 * session's `NotepadFileStorage`, whose watch (file watcher
 * plus a one-second poll) brings changes made elsewhere: the page reloads the
 * Edit tab unless it holds unsaved edits (then it asks), and the View tab
 * follows. The panel writes the file on the user's behalf only; no agent tool
 * writes it.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { registerGatedWebviewViewProvider } from './webviewViewGate';
import type { NotepadFileStorage } from './notepad/notepadFileStorage';
import { handleNotesFileMessage } from './notepad/notesFileActions';
import { QuestNotesSession, type QuestNotesPickerState } from './notepad/questNotesSession';
import { wireQuestHintMessages } from './questHint-handler';
import { followMdLink, openMarkdownBrowser } from './markdownBrowser-handler';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { renderQuestLogMarkdown } from '../utils/questLogMarkdown';
import { transformMarkdown } from '../utils/markdownHeadings';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { wireCompletionMessages } from '../utils/completionWiring';
import { WsPaths } from '../utils/workspacePaths';

export const QUEST_NOTES_PANEL_VIEW_ID = 'tomAi.questNotesPanel';

/** The MD Browser scripts the View tab runs, in load order (media/-relative). */
export const VIEW_SCRIPTS = ['shared/mdOverlay.js', 'shared/mdQuestions.js', 'markdownBrowser/blocks.js', 'markdownBrowser/teamReview.js', 'markdownBrowser/main.js'];
/** The MD Browser styles the View tab uses. */
export const VIEW_STYLES = ['shared/mdOverlay.css', 'markdownBrowser/style.css'];

/** What the page is told about the notes: the file shown and the picker's list. */
export interface NotesState extends QuestNotesPickerState {
    type: 'notesState';
    hasQuest: boolean;
    questId: string;
    filePath: string;
    relativePath: string;
    content: string;
    /** `true`: the content came from a change on disk, not from opening the view. */
    external?: boolean;
}

export class QuestNotesPanelProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private readonly _session: QuestNotesSession;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _context: vscode.ExtensionContext,
        /** The poll interval of the file watch; tests pass a short one. */
        pollMs?: number,
    ) {
        this._session = new QuestNotesSession(_context, (external) => this._sendState(external), pollMs);
    }

    private get _storage(): NotepadFileStorage | null { return this._session.storage; }

    dispose(): void {
        this._session.dispose();
        for (const d of this._disposables.splice(0)) { d.dispose(); }
    }

    /** The storage on the notes file shown (the default is created with its header when missing); null without a quest. */
    load(): NotepadFileStorage | null {
        return this._session.load();
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        const media = vscode.Uri.joinPath(this._context.extensionUri, 'media');
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                media,
                vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', 'marked', 'lib'),
                vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) || []),
            ],
        };
        const uri = (...segments: string[]): string => webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, ...segments)).toString();
        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'questNotesPanel', {
            init: {
                codiconsUri: uri('node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
                styles: VIEW_STYLES.map((f) => uri('media', ...f.split('/'))),
                scripts: [uri('node_modules', 'marked', 'lib', 'marked.umd.js'), ...VIEW_SCRIPTS.map((f) => uri('media', ...f.split('/')))],
            },
        });
        wireCompletionMessages(webviewView.webview);
        this._disposables.push(wireQuestHintMessages(webviewView.webview));
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this._sendState(false); }
        }, undefined, this._disposables);
        webviewView.onDidDispose(() => { this._view = undefined; }, undefined, this._disposables);
        webviewView.webview.onDidReceiveMessage((msg) => { void this.handleMessage(msg); }, undefined, this._disposables);
    }

    /** One message of the page. Public for the tests. */
    async handleMessage(msg: { type?: string; [key: string]: unknown }): Promise<void> {
        switch (msg?.type) {
            case 'ready':
                this._sendState(false);
                return;
            case 'webviewReady':
                // The MD Browser's renderer is up (it loads after the page): the View tab's content.
                if (this._storage) { this._postView(this._storage.content); } else { this._sendState(false); }
                return;
            case 'save': {
                const storage = this._storage ?? this.load();
                if (!storage || typeof msg.content !== 'string') { return; }
                if (msg.content !== storage.content) { storage.save(msg.content); }
                this._postView(storage.content);
                return;
            }
            case 'openInEditor':
            case 'openInMdBrowser':
            case 'openInMdViewer':
                await handleNotesFileMessage(msg.type, this._storage ?? this.load(), this._context);
                return;
            case 'navigateLink': {
                const href = String(msg.href || '');
                if (!href || !this._storage) { return; }
                await followMdLink(href, this._storage.path, {
                    scrollToAnchor: (anchor) => { void this._view?.webview.postMessage({ type: 'scrollToAnchor', anchor }); },
                    // Another document opens in the MD Browser: the panel shows only the quest notes.
                    openMarkdown: (filePath, anchor) => { openMarkdownBrowser(this._context, filePath, { anchor }); },
                });
                return;
            }
            case 'renderMarkdown':
                void this._view?.webview.postMessage({ type: 'markdownHtml', title: String(msg.title || ''), html: renderQuestLogMarkdown(String(msg.markdown || '')) });
                return;
            case 'openMarkdownPreview':
                await showMarkdownHtmlPreview(this._context, { title: String(msg.title || 'Comment'), markdown: String(msg.markdown || '') });
                return;
            case 'reload':
                if (this._storage) { this._storage.load(); this._sendState(false); }
                return;
            case 'selectNotesFile':
            case 'newNotesFile':
                await this._session.handleMessage(msg);
                return;
            default:
                // The MD Browser's writing messages (applyEdit, reviewMark, ...) are not taken:
                // the View tab is read-only; the Edit tab writes the file.
                return;
        }
    }

    private _sendState(external: boolean): void {
        const storage = external ? this._storage : this.load();
        const view = this._view;
        if (!view) { return; }
        const quest = this._session.questId;
        view.title = quest ? `QUEST NOTES — ${quest}` : 'QUEST NOTES';
        const state: NotesState = {
            type: 'notesState',
            hasQuest: !!storage,
            questId: quest,
            filePath: storage?.path ?? '',
            relativePath: storage ? relativeToWorkspace(storage.path) : '',
            content: storage?.content ?? '',
            ...this._session.pickerState,
            ...(external ? { external: true } : {}),
        };
        void view.webview.postMessage(state);
        if (storage) { this._postView(storage.content); }
    }

    /** The View tab: the content as the MD Browser renders a file. */
    private _postView(content: string): void {
        const storage = this._storage;
        if (!this._view || !storage) { return; }
        void this._view.webview.postMessage({
            type: 'mdContent',
            content: transformMarkdown(content),
            filePath: storage.path,
            relativePath: relativeToWorkspace(storage.path),
            fileName: path.basename(storage.path),
            crlf: false,
        });
    }
}

function relativeToWorkspace(p: string): string {
    const root = WsPaths.wsRoot || '';
    return root ? path.relative(root, p) : path.basename(p);
}

let provider: QuestNotesPanelProvider | undefined;

export function registerQuestNotesPanel(context: vscode.ExtensionContext): void {
    provider = new QuestNotesPanelProvider(context);
    context.subscriptions.push(
        registerGatedWebviewViewProvider(QUEST_NOTES_PANEL_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
        { dispose: () => provider?.dispose() },
    );
}
