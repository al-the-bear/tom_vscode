/**
 * The "open the notes file" buttons the three NOTES panels share (VS CODE
 * NOTES, WORKSPACE NOTES, QUEST NOTES): Open in Editor, Open in MD Browser
 * and Open in MD Viewer (the external Markdown application, MarkText by
 * default). Each panel answers its webview's message with
 * {@link handleNotesFileMessage}; the file is created first when it is
 * missing, so every button opens something.
 */

import * as vscode from 'vscode';

/** The webview messages the open buttons post. */
export const NOTES_FILE_MESSAGES = ['openInEditor', 'openInMdBrowser', 'openInMdViewer'] as const;
export type NotesFileMessage = typeof NOTES_FILE_MESSAGES[number];

/** What the buttons open the file with; injectable so tests need no panels. */
export interface NotesFileOpeners {
    openInEditor(filePath: string): Promise<void>;
    openInMdBrowser(context: vscode.ExtensionContext, filePath: string): void;
    openInMdViewer(filePath: string): Promise<unknown>;
}

/** The notes file a panel shows: its path, and a way to create it when missing. */
export interface NotesFile {
    readonly path: string;
    ensureFile(): void;
}

const defaultOpeners: NotesFileOpeners = {
    async openInEditor(filePath) {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
    },
    openInMdBrowser(context, filePath) {
        // Why lazily: the MD Browser module pulls in its whole panel stack,
        // which the notes panels should not load until a button asks for it.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { openMarkdownBrowser } = require('../markdownBrowser-handler') as typeof import('../markdownBrowser-handler');
        openMarkdownBrowser(context, filePath);
    },
    openInMdViewer(filePath) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { openInExternalApplication } = require('../handler_shared') as typeof import('../handler_shared');
        return openInExternalApplication(filePath);
    },
};

export function isNotesFileMessage(type: unknown): type is NotesFileMessage {
    return typeof type === 'string' && (NOTES_FILE_MESSAGES as readonly string[]).includes(type);
}

/**
 * Open the panel's notes file as the message asks. Answers false for any
 * other message, so a panel can try this before its own cases. Without a
 * file (no quest, no workspace notes file chosen) it warns and opens nothing.
 */
export async function handleNotesFileMessage(
    type: unknown,
    file: NotesFile | null | undefined,
    context: vscode.ExtensionContext,
    openers: NotesFileOpeners = defaultOpeners,
): Promise<boolean> {
    if (!isNotesFileMessage(type)) { return false; }
    if (!file) {
        vscode.window.showWarningMessage('No notes file configured');
        return true;
    }
    file.ensureFile();
    switch (type) {
        case 'openInEditor': await openers.openInEditor(file.path); break;
        case 'openInMdBrowser': openers.openInMdBrowser(context, file.path); break;
        case 'openInMdViewer': await openers.openInMdViewer(file.path); break;
    }
    return true;
}
