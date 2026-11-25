/**
 * Reusable Prompt Editor — full-screen webview panel.
 *
 * The editor of the active quest's saved prompts: the `*.prompt.md` files of
 * `_ai/quests/<quest>/prompt/` (utils/questPrompts.ts). There is no other
 * place a saved prompt lives, so the page has no scope to choose; a window
 * without a quest is told so and edits nothing.
 *
 * Layout: top action bar with add / rename / delete / up / down / preview /
 * open, left column the file list, right column the Markdown editor.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { wireCompletionMessages } from '../utils/completionWiring';
import { inStoredOrder, moveInStoredOrder, renameInStoredOrder } from '../services/editorListOrder';
import { moveDirection, type MoveDirection } from '../utils/listOrder';
import {
    NO_QUEST_PROMPTS_MESSAGE,
    activeQuestPromptFolder,
    deleteQuestPrompt,
    listQuestPromptFiles,
    notifyQuestPromptsChanged,
    questPromptFileName,
    questPromptFilePath,
    questPromptsListKey,
    renameQuestPrompt,
    writeQuestPrompt,
    type QuestPromptFile,
    type QuestPromptFolder,
} from '../utils/questPrompts';

/** What opening the editor may pre-select: a prompt file of the active quest. */
export interface ReusablePromptEditorOptions {
    fileId?: string;
}

// ============================================================================
// Panel management
// ============================================================================

let _panel: vscode.WebviewPanel | undefined;
let _context: vscode.ExtensionContext | undefined;

/**
 * Open the reusable prompt editor, optionally pre-selecting a file.
 */
export function openReusablePromptEditor(
    context: vscode.ExtensionContext,
    options?: ReusablePromptEditorOptions,
): void {
    _context = context;

    if (_panel) {
        _panel.reveal();
        if (options?.fileId) {
            _panel.webview.postMessage({ type: 'selectFile', fileId: options.fileId });
        }
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'tomAi.reusablePromptEditor',
        'Reusable Prompt Editor',
        vscode.ViewColumn.Active,
        {
            ...getReusablePromptEditorWebviewOptions(context),
            retainContextWhenHidden: true,
        },
    );
    bindReusablePromptEditorPanel(context, panel, options);
}

/** Webview options shared by the fresh-open and reload-restore paths. */
function getReusablePromptEditorWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
    };
}

/**
 * Wire a (freshly-created or reload-restored) Reusable Prompt editor panel:
 * install the message handler, paint the HTML, and push the file list. Both
 * `openReusablePromptEditor` and the reload serializer call this so the wiring
 * lives in one place. `options` carries the file to pre-select — on restore it
 * comes from the webview's persisted `setState`, so the editor re-opens the
 * prompt the user was last editing.
 */
function bindReusablePromptEditorPanel(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    options?: ReusablePromptEditorOptions,
): void {
    _context = context;
    _panel = panel;

    const codiconsUri = vscode.Uri.joinPath(
        context.extensionUri,
        'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
    );
    const webviewCodiconsUri = panel.webview.asWebviewUri(codiconsUri);

    panel.webview.onDidReceiveMessage(
        (msg) => handleReusablePromptEditorMessage(msg),
        undefined,
        context.subscriptions,
    );
    wireCompletionMessages(panel.webview);

    panel.webview.html = _getHtml(panel.webview, webviewCodiconsUri.toString());

    panel.onDidDispose(() => { _panel = undefined; });

    setTimeout(() => {
        _sendData(_post, options?.fileId);
    }, 100);
}

export function registerReusablePromptEditorCommand(ctx: vscode.ExtensionContext): void {
    _context = ctx;
    ctx.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.reusablePrompts', (args?: any) => {
            openReusablePromptEditor(ctx, { fileId: typeof args?.fileId === 'string' ? args.fileId : undefined });
        }),
    );
    // Restore the panel after a window reload. Singleton; the webview persists
    // its selected {fileId} via setState, so the deserialize path re-opens the
    // prompt the user was editing. Without the serializer
    // the tab silently vanishes on reload.
    ctx.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('tomAi.reusablePromptEditor', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: any): Promise<void> {
                if (_panel) { panel.dispose(); return; }
                const context = _context ?? ctx;
                panel.webview.options = getReusablePromptEditorWebviewOptions(context);
                bindReusablePromptEditorPanel(context, panel, { fileId: typeof state?.fileId === 'string' ? state.fileId : undefined });
            },
        }),
    );
}

// ============================================================================
// The active quest's list
// ============================================================================

type Post = (message: Record<string, unknown>) => void;

const _post: Post = (message) => { void _panel?.webview.postMessage(message); };

/** The quest's prompt files in the order the Up / Down buttons gave them; a file not placed yet follows by name. */
function _orderedPromptFiles(folder: QuestPromptFolder): QuestPromptFile[] {
    return inStoredOrder(questPromptsListKey(folder.questId), listQuestPromptFiles(folder.dir), (f) => f.id);
}

/** What the page shows: the quest ('' without one) and its prompt files. */
export function reusablePromptEditorData(fileId?: string): Record<string, unknown> {
    const folder = activeQuestPromptFolder();
    return {
        type: 'data',
        quest: folder?.questId ?? '',
        noQuestMessage: folder ? '' : NO_QUEST_PROMPTS_MESSAGE,
        files: folder ? _orderedPromptFiles(folder) : [],
        initialFileId: folder && fileId ? fileId : '',
    };
}

function _sendData(post: Post, fileId?: string): void {
    post(reusablePromptEditorData(fileId));
}

/** The active quest's folder, or null after telling the user that the window has none. */
function _folderOrWarn(): QuestPromptFolder | null {
    const folder = activeQuestPromptFolder();
    if (!folder) { vscode.window.showWarningMessage(NO_QUEST_PROMPTS_MESSAGE); }
    return folder;
}

// ============================================================================
// Message handling
// ============================================================================

/**
 * A message from the page. Every action is on the active quest's folder: a
 * `scope` / `subScopeId` a message carries is not read.
 */
export async function handleReusablePromptEditorMessage(msg: Record<string, unknown>, post: Post = _post): Promise<void> {
    const fileId = String(msg.fileId ?? '');
    switch (msg.type) {
        case 'ready':
            _sendData(post);
            break;
        case 'requestData':
            _sendData(post, fileId || undefined);
            break;
        case 'loadFile':
            _sendFileContent(post, fileId);
            break;
        case 'save':
            _saveFile(fileId, String(msg.content ?? ''));
            break;
        case 'add':
            await _addFile(post);
            break;
        case 'rename':
            await _renameFile(post, fileId);
            break;
        case 'delete':
            await _deleteFile(post, fileId);
            break;
        case 'move':
            _moveFile(post, fileId, moveDirection(msg.direction));
            break;
        case 'openInVsCode':
            await _openInVsCode(fileId);
            break;
        case 'openInPreview':
            await _openInPreview(fileId);
            break;
    }
}

/** Up / Down: the file moves one place in the quest's list; the order is stored, the files are not touched. */
function _moveFile(post: Post, fileId: string, direction: MoveDirection | undefined): void {
    const folder = activeQuestPromptFolder();
    if (!folder || !fileId || !direction) { return; }
    const shown = _orderedPromptFiles(folder).map((f) => f.id);
    if (!moveInStoredOrder(questPromptsListKey(folder.questId), shown, fileId, direction)) { return; }
    post({ type: 'filesReordered', files: _orderedPromptFiles(folder) });
    notifyQuestPromptsChanged();
}

function _sendFileContent(post: Post, fileId: string): void {
    const folder = activeQuestPromptFolder();
    const filePath = folder ? questPromptFilePath(folder.dir, fileId) : null;
    let content = '';
    if (filePath) {
        try { content = fs.readFileSync(filePath, 'utf-8'); } catch { /* empty */ }
    }
    post({ type: 'fileContent', fileId, content });
}

function _saveFile(fileId: string, content: string): void {
    const folder = _folderOrWarn();
    if (!folder) { return; }
    const written = writeQuestPrompt(folder.dir, fileId, content, true);
    if (!written.ok) {
        vscode.window.showWarningMessage(written.error);
        return;
    }
    vscode.window.showInformationMessage(`Saved ${fileId}`);
}

/** Ask for a prompt file name; `.prompt.md` is added when it is left out. */
async function _askFileName(prompt: string, value?: string): Promise<string | null> {
    const typed = await vscode.window.showInputBox({
        prompt,
        placeHolder: 'my_prompt.prompt.md',
        value,
        validateInput: (v) => (questPromptFileName(v) ? null : 'A file name is required (no folder part)'),
    });
    return typed ? questPromptFileName(typed) : null;
}

async function _addFile(post: Post): Promise<void> {
    const folder = _folderOrWarn();
    if (!folder) { return; }
    const name = await _askFileName('New reusable prompt filename');
    if (!name) { return; }
    const written = writeQuestPrompt(folder.dir, name, `# ${name.replace(/\.prompt\.md$/, '')}\n\n`);
    if (!written.ok) {
        vscode.window.showWarningMessage(written.error);
        return;
    }
    post({ type: 'files', files: _orderedPromptFiles(folder), selectFileId: name });
    notifyQuestPromptsChanged();
}

/** Rename: the file gets its new name in the quest's folder and keeps its place in the list. */
async function _renameFile(post: Post, fileId: string): Promise<void> {
    const folder = _folderOrWarn();
    if (!folder || !fileId) { return; }
    const name = await _askFileName(`Rename "${fileId}" to`, fileId);
    if (!name || name === fileId) { return; }
    const renamed = renameQuestPrompt(folder.dir, fileId, name);
    if (!renamed.ok) {
        vscode.window.showWarningMessage(renamed.error);
        return;
    }
    renameInStoredOrder(questPromptsListKey(folder.questId), fileId, name);
    post({ type: 'fileRenamed', fileId, newFileId: name, files: _orderedPromptFiles(folder) });
    notifyQuestPromptsChanged();
}

async function _deleteFile(post: Post, fileId: string): Promise<void> {
    const folder = activeQuestPromptFolder();
    if (!folder || !questPromptFilePath(folder.dir, fileId)) { return; }

    const confirm = await vscode.window.showWarningMessage(
        `Delete "${fileId}"?`, { modal: true }, 'Delete',
    );
    if (confirm !== 'Delete') { return; }

    deleteQuestPrompt(folder.dir, fileId);
    post({ type: 'files', files: _orderedPromptFiles(folder) });
    post({ type: 'fileDeleted', fileId });
    notifyQuestPromptsChanged();
}

/** The path of an existing prompt file of the active quest, or null after a warning. */
function _existingFile(fileId: string): string | null {
    const folder = activeQuestPromptFolder();
    const filePath = folder ? questPromptFilePath(folder.dir, fileId) : null;
    if (!filePath || !fs.existsSync(filePath)) {
        vscode.window.showWarningMessage('File not found.');
        return null;
    }
    return filePath;
}

async function _openInVsCode(fileId: string): Promise<void> {
    const filePath = _existingFile(fileId);
    if (!filePath) { return; }
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });
}

async function _openInPreview(fileId: string): Promise<void> {
    if (!_context) { return; }
    const filePath = _existingFile(fileId);
    if (!filePath) { return; }
    await showMarkdownHtmlPreview(_context, {
        title: fileId,
        markdown: fs.readFileSync(filePath, 'utf-8'),
        meta: filePath,
    });
}

// ============================================================================
// HTML
// ============================================================================

function _getHtml(webview: vscode.Webview, codiconsUri: string): string {
    return loadWebviewHtml(webview, 'reusablePromptEditor', {
        init: { codiconsUri },
    });
}
