/**
 * Notepad WebviewView Provider
 * 
 * Provides notepad/scratchpad views for VS Code.
 * - Dartscript Notepad: Explorer sidebar
 * - Tom Notepad: Bottom panel
 * Content is persisted across sessions using workspaceState.
 */

import * as vscode from 'vscode';

const DARTSCRIPT_NOTEPAD_VIEW_ID = 'tomAi.notepad';
const TOM_NOTEPAD_VIEW_ID = 'tomAi.tomNotepad';
const DARTSCRIPT_STORAGE_KEY = 'dartscript.notepad.content';
const TOM_STORAGE_KEY = 'dartscript.tomNotepad.content';

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
            localResourceRoots: []
        };

        webviewView.webview.html = this._getHtmlContent();

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

    private _getHtmlContent(): string {
        const escapedContent = this._escapeHtml(this._content);
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            padding: 8px;
            height: 100vh;
            display: flex;
            flex-direction: column;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            background-color: var(--vscode-panel-background);
            color: var(--vscode-foreground);
        }
        .toolbar {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
            flex-shrink: 0;
        }
        button {
            padding: 4px 10px;
            border: none;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            border-radius: 2px;
            font-size: 12px;
        }
        button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        button.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        button.primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        #notepad {
            flex: 1;
            width: 100%;
            resize: none;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 8px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            line-height: 1.4;
            outline: none;
        }
        #notepad:focus {
            border-color: var(--vscode-focusBorder);
        }
        #notepad::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .char-count {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            text-align: right;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button class="primary" id="sendBtn" title="Send selected text (or all) to Copilot Chat">Send to Chat</button>
        <button id="copyBtn" title="Copy selected text (or all) to clipboard">Copy</button>
        <button id="clearBtn" title="Clear notepad">Clear</button>
    </div>
    <textarea id="notepad" placeholder="${this._placeholderText}">${escapedContent}</textarea>
    <div class="char-count"><span id="charCount">0</span> chars | <span id="selCount">0</span> selected</div>

    <script>
        const vscode = acquireVsCodeApi();
        const notepad = document.getElementById('notepad');
        const charCount = document.getElementById('charCount');
        const selCount = document.getElementById('selCount');
        const sendBtn = document.getElementById('sendBtn');
        const copyBtn = document.getElementById('copyBtn');
        const clearBtn = document.getElementById('clearBtn');

        let saveTimeout;

        function updateCharCount() {
            charCount.textContent = notepad.value.length;
        }

        function updateSelCount() {
            const start = notepad.selectionStart;
            const end = notepad.selectionEnd;
            selCount.textContent = end - start;
        }

        function getSelectedOrAll() {
            const start = notepad.selectionStart;
            const end = notepad.selectionEnd;
            if (start !== end) {
                return notepad.value.substring(start, end);
            }
            return notepad.value;
        }

        function saveContent() {
            vscode.postMessage({ type: 'save', content: notepad.value });
        }

        function debouncedSave() {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(saveContent, 500);
        }

        notepad.addEventListener('input', () => {
            updateCharCount();
            updateSelCount();
            debouncedSave();
        });

        notepad.addEventListener('select', updateSelCount);
        notepad.addEventListener('click', updateSelCount);
        notepad.addEventListener('keyup', updateSelCount);

        sendBtn.addEventListener('click', () => {
            const selected = getSelectedOrAll();
            vscode.postMessage({ 
                type: 'sendToChat', 
                content: notepad.value,
                selectedText: notepad.selectionStart !== notepad.selectionEnd ? selected : null
            });
        });

        copyBtn.addEventListener('click', () => {
            const selected = getSelectedOrAll();
            vscode.postMessage({ 
                type: 'copyToClipboard', 
                content: notepad.value,
                selectedText: notepad.selectionStart !== notepad.selectionEnd ? selected : null
            });
        });

        clearBtn.addEventListener('click', () => {
            if (notepad.value.trim() === '' || confirm('Clear all content?')) {
                notepad.value = '';
                updateCharCount();
                updateSelCount();
                vscode.postMessage({ type: 'clear' });
            }
        });

        // Handle messages from extension
        window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.type) {
                case 'restore':
                    notepad.value = message.content || '';
                    updateCharCount();
                    updateSelCount();
                    break;
                case 'cleared':
                    notepad.value = '';
                    updateCharCount();
                    updateSelCount();
                    break;
            }
        });

        // Initial counts
        updateCharCount();
        updateSelCount();
    </script>
</body>
</html>`;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
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
let dartscriptNotepadProvider: NotepadViewProvider | undefined;
let tomNotepadProvider: NotepadViewProvider | undefined;

/**
 * Register both notepad WebviewView providers
 */
export function registerNotepadView(context: vscode.ExtensionContext): void {
    // Dartscript Notepad (Explorer sidebar)
    dartscriptNotepadProvider = new NotepadViewProvider(
        context,
        DARTSCRIPT_STORAGE_KEY,
        'Quick notes, prompt drafts, scratch space...\\n\\nContent is auto-saved.'
    );
    
    // Tom Notepad (Bottom panel)
    tomNotepadProvider = new NotepadViewProvider(
        context,
        TOM_STORAGE_KEY,
        'Tom Notepad - Panel scratchpad...\\n\\nSelect text to send only selection.'
    );
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(DARTSCRIPT_NOTEPAD_VIEW_ID, dartscriptNotepadProvider),
        vscode.window.registerWebviewViewProvider(TOM_NOTEPAD_VIEW_ID, tomNotepadProvider)
    );
}

/**
 * Get the Dartscript notepad provider instance
 */
export function getNotepadProvider(): NotepadViewProvider | undefined {
    return dartscriptNotepadProvider;
}

/**
 * Get the Tom notepad provider instance
 */
export function getTomNotepadProvider(): NotepadViewProvider | undefined {
    return tomNotepadProvider;
}
