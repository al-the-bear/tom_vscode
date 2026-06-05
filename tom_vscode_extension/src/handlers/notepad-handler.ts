/**
 * Notepad WebviewView Provider
 * 
 * Provides notepad/scratchpad views for VS Code.
 * - Workspace Notepad: Explorer sidebar
 * - Tom Notepad: Bottom panel
 * Content is persisted across sessions using workspaceState.
 */

import * as vscode from 'vscode';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { wireCompletionMessages } from '../utils/completionWiring';

const WS_NOTEPAD_VIEW_ID = 'tomAi.notepad';
const TOM_NOTEPAD_VIEW_ID = 'tomAi.vscodeNotes';
const WS_NOTEPAD_STORAGE_KEY = 'tomAi.notepad.content';
const TOM_STORAGE_KEY = 'tomAi.vscodeNotes.content';

/**
 * Generic WebviewView provider for notepads
 */
class NotepadViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _content: string = '';

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _storageKey: string,
        private readonly _placeholderText: string
    ) {
        // Load saved content
        this._content = this._context.workspaceState.get<string>(this._storageKey, '');
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'media')
            ]
        };

        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'notepad', {
            init: {
                content: this._content,
                placeholderText: this._placeholderText
            }
        });

        // Shared textarea completion (Ctrl+Shift+Space → /skill + @file). The
        // webview posts `requestCompletion`; this wiring shows the picker and
        // posts the chosen `insertCompletion` back. Registered as its own
        // listener so it coexists with the message handler below.
        wireCompletionMessages(webviewView.webview);

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'save':
                    this._content = message.content;
                    await this._context.workspaceState.update(this._storageKey, this._content);
                    break;
                case 'sendToChat':
                    // Send selected text if provided, otherwise full content
                    const textToSend = message.selectedText || message.content;
                    if (textToSend.trim()) {
                        await vscode.commands.executeCommand('workbench.action.chat.open', {
                            query: textToSend
                        });
                    }
                    break;
                case 'copyToClipboard':
                    const textToCopy = message.selectedText || message.content;
                    if (textToCopy) {
                        await vscode.env.clipboard.writeText(textToCopy);
                        vscode.window.showInformationMessage('Copied to clipboard');
                    }
                    break;
                case 'clear':
                    this._content = '';
                    await this._context.workspaceState.update(this._storageKey, '');
                    if (this._view) {
                        this._view.webview.postMessage({ type: 'cleared' });
                    }
                    break;
            }
        });

        // Handle visibility changes
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this._view) {
                this._view.webview.postMessage({ 
                    type: 'restore', 
                    content: this._content 
                });
            }
        });
    }

    /**
     * Get the current notepad content
     */
    public getContent(): string {
        return this._content;
    }

    /**
     * Set notepad content programmatically
     */
    public setContent(content: string): void {
        this._content = content;
        this._context.workspaceState.update(this._storageKey, content);
        if (this._view) {
            this._view.webview.postMessage({ type: 'restore', content });
        }
    }
}

// Global provider instances
let workspaceNotepadProvider: NotepadViewProvider | undefined;
let tomNotepadProvider: NotepadViewProvider | undefined;

/**
 * Register both notepad WebviewView providers
 */
export function registerNotepadView(context: vscode.ExtensionContext): void {
    // Workspace Notepad (Explorer sidebar)
    workspaceNotepadProvider = new NotepadViewProvider(
        context,
        WS_NOTEPAD_STORAGE_KEY,
        'Quick notes, prompt drafts, scratch space...\\n\\nContent is auto-saved.'
    );
    
    // Tom Notepad (Bottom panel)
    tomNotepadProvider = new NotepadViewProvider(
        context,
        TOM_STORAGE_KEY,
        'Tom Notepad - Panel scratchpad...\\n\\nSelect text to send only selection.'
    );
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(WS_NOTEPAD_VIEW_ID, workspaceNotepadProvider),
        vscode.window.registerWebviewViewProvider(TOM_NOTEPAD_VIEW_ID, tomNotepadProvider)
    );
}

/**
 * Get the workspace notepad provider instance
 */
export function getNotepadProvider(): NotepadViewProvider | undefined {
    return workspaceNotepadProvider;
}

/**
 * Get the Tom notepad provider instance
 */
export function getTomNotepadProvider(): NotepadViewProvider | undefined {
    return tomNotepadProvider;
}
