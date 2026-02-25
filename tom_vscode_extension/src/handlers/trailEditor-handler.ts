/**
 * Custom Editor Provider for *.prompts.md and *.answers.md trail files.
 *
 * Provides a consolidated view of prompt/answer exchanges with:
 * - Quest dropdown to switch between trail files
 * - Chronological list of prompts and answers (left panel)
 * - Markdown preview of selected entry (right upper panel)
 * - Metadata panel (right lower panel)
 * - Draggable panel separators
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WsPaths } from '../utils/workspacePaths';
import { debugLog } from '../utils/debugLogger';
import { readWorkspaceTodos } from '../managers/questTodoManager.js';
import { selectTodoInBottomPanel } from './questTodoPanel-handler.js';

// ============================================================================
// Types
// ============================================================================

export interface TrailEntry {
    type: 'PROMPT' | 'ANSWER';
    requestId: string;
    timestamp: string;     // ISO timestamp from readable format
    rawTimestamp: string;   // original readable timestamp string
    sequence: number;
    content: string;       // markdown body (without metadata)
    // Metadata — prompts
    templateName?: string;
    answerWrapper?: string;
    // Metadata — answers
    comments?: string;
    variables?: string;
    references?: string[];
    attachments?: string[];
}

// ============================================================================
// Registration
// ============================================================================

export function registerTrailCustomEditor(context: vscode.ExtensionContext): void {
    const provider = new TrailEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'trailViewer.editor',
            provider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );
}

// ============================================================================
// Provider
// ============================================================================

class TrailEditorProvider implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        const codiconsUri = vscode.Uri.joinPath(
            this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
        );
        const markedUri = vscode.Uri.joinPath(
            this.context.extensionUri, 'node_modules', 'marked', 'lib', 'marked.umd.js',
        );

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'marked', 'lib'),
            ],
        };

        const webviewCodiconsUri = webviewPanel.webview.asWebviewUri(codiconsUri);
        const webviewMarkedUri = webviewPanel.webview.asWebviewUri(markedUri);

        // Determine which trail set to load based on opened file
        const openedFile = document.uri.fsPath;
        const trailFolder = path.dirname(openedFile);
        const basename = path.basename(openedFile);

        // Discover all trail sets (quest name -> { prompts, answers })
        const trailSets = discoverTrailSets(trailFolder);
        const currentSet = identifyCurrentSet(basename, trailSets);

        // Parse entries from the current set
        const entries = loadTrailSet(trailFolder, currentSet, trailSets);

        webviewPanel.webview.html = buildHtml(
            webviewCodiconsUri.toString(),
            webviewMarkedUri.toString(),
            trailSets,
            currentSet,
            entries,
        );

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'switchQuest': {
                        const newEntries = loadTrailSet(trailFolder, message.quest, trailSets);
                        webviewPanel.webview.postMessage({
                            type: 'updateEntries',
                            entries: newEntries,
                            quest: message.quest,
                        });
                        break;
                    }
                    case 'openInEditor': {
                        const set = trailSets.get(message.quest || currentSet);
                        if (set) {
                            const file = message.fileType === 'prompts' ? set.prompts : set.answers;
                            if (file) {
                                const filePath = path.join(trailFolder, file);
                                if (fs.existsSync(filePath)) {
                                    const uri = vscode.Uri.file(filePath);
                                    await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
                                }
                            }
                        }
                        break;
                    }
                    case 'gotoTodo': {
                        if (message.todoId) {
                            await gotoWorkspaceTodo(this.context, message.todoId, message.todoPath || '');
                        }
                        break;
                    }
                    case 'openInMdViewer': {
                        const set = trailSets.get(message.quest || currentSet);
                        if (set) {
                            const file = message.fileType === 'prompts' ? set.prompts : set.answers;
                            if (file) {
                                const filePath = path.join(trailFolder, file);
                                try {
                                    const { openInExternalApplication } = await import('./handler_shared.js');
                                    await openInExternalApplication(filePath);
                                } catch (e) {
                                    debugLog(`[TrailEditor] Failed to open in MD viewer: ${e}`, 'ERROR', 'extension');
                                }
                            }
                        }
                        break;
                    }
                }
            },
            undefined,
            this.context.subscriptions,
        );

        // Watch trail folder for changes
        const watcher = fs.watch(trailFolder, (_eventType, filename) => {
            if (filename && (filename.endsWith('.prompts.md') || filename.endsWith('.answers.md'))) {
                const updatedSets = discoverTrailSets(trailFolder);
                const updatedEntries = loadTrailSet(trailFolder, currentSet, updatedSets);
                webviewPanel.webview.postMessage({
                    type: 'updateEntries',
                    entries: updatedEntries,
                    quest: currentSet,
                    trailSets: Object.fromEntries(updatedSets),
                });
            }
        });

        webviewPanel.onDidDispose(() => {
            watcher.close();
        });
    }
}

// ============================================================================
// Trail file discovery and parsing
// ============================================================================

export interface TrailSet {
    prompts?: string;  // filename
    answers?: string;  // filename
}

// ---- Navigate to a workspace TODO by its ID ----
// Selects the TODO in the bottom-panel Quest TODO view, or falls back to the custom editor.
async function gotoWorkspaceTodo(ctx: vscode.ExtensionContext, todoId: string, _todoPath: string): Promise<void> {
    try {
        // Extract quest ID and file name from the path
        // Path format: _ai/quests/<questId>/<filename>.todo.yaml/<todoId>
        let questId: string | undefined;
        let fileName: string | undefined;
        if (_todoPath) {
            const questMatch = _todoPath.match(/(?:^|\/|\\)_ai[\/\\]quests[\/\\]([^\/\\]+)[\/\\]([^\/\\]+?)(?:[\/\\]|$)/);
            if (questMatch) {
                questId = questMatch[1];
                fileName = questMatch[2];
            }
        }

        // Try to select in the bottom panel first
        const selected = await selectTodoInBottomPanel(todoId, fileName, questId);
        if (selected) return;

        // Fallback: open the YAML file with the Quest TODO custom editor
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) return;

        let yamlRelPath = '';
        let yamlAbsPath = '';
        if (_todoPath) {
            const lastSlash = _todoPath.lastIndexOf('/');
            if (lastSlash > 0) {
                yamlRelPath = _todoPath.substring(0, lastSlash);
                yamlAbsPath = path.join(wsRoot, yamlRelPath);
            }
        }

        if (!yamlAbsPath || !fs.existsSync(yamlAbsPath)) {
            const todos = readWorkspaceTodos();
            const todo = todos.find((t) => String(t.id) === todoId);
            if (todo && todo._sourceFile) {
                yamlRelPath = path.join('_ai', 'quests', todo._sourceFile);
                yamlAbsPath = path.join(wsRoot, yamlRelPath);
            }
        }

        if (!yamlAbsPath || !fs.existsSync(yamlAbsPath)) {
            vscode.window.showWarningMessage('TODO ' + todoId + ': source file not found.');
            return;
        }

        await ctx.workspaceState.update('qt.pendingSelect', {
            file: yamlRelPath,
            todoId: todoId,
        });
        const uri = vscode.Uri.file(yamlAbsPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'questTodo.editor');
    } catch (e) {
        debugLog('[TrailEditor] gotoTodo error: ' + e, 'ERROR', 'extension');
    }
}

export function discoverTrailSets(trailFolder: string): Map<string, TrailSet> {
    const sets = new Map<string, TrailSet>();
    
    if (!fs.existsSync(trailFolder)) { return sets; }
    
    const files = fs.readdirSync(trailFolder);
    for (const f of files) {
        let name: string | undefined;
        if (f.endsWith('.prompts.md')) {
            name = f.replace(/\.prompts\.md$/, '');
            if (!sets.has(name)) { sets.set(name, {}); }
            sets.get(name)!.prompts = f;
        } else if (f.endsWith('.answers.md')) {
            name = f.replace(/\.answers\.md$/, '');
            if (!sets.has(name)) { sets.set(name, {}); }
            sets.get(name)!.answers = f;
        }
        // Also handle legacy _prompts.md / _answers.md files
        else if (f.endsWith('_prompts.md')) {
            name = f.replace(/_prompts\.md$/, '');
            if (!sets.has(name)) { sets.set(name, {}); }
            if (!sets.get(name)!.prompts) { sets.get(name)!.prompts = f; }
        } else if (f.endsWith('_answers.md')) {
            name = f.replace(/_answers\.md$/, '');
            if (!sets.has(name)) { sets.set(name, {}); }
            if (!sets.get(name)!.answers) { sets.get(name)!.answers = f; }
        }
    }
    
    return sets;
}

function identifyCurrentSet(basename: string, sets: Map<string, TrailSet>): string {
    // Match against known set names
    for (const [name, set] of sets) {
        if (set.prompts === basename || set.answers === basename) {
            return name;
        }
    }
    // Fallback: extract name from filename
    const cleanName = basename
        .replace(/\.(prompts|answers)\.md$/, '')
        .replace(/_(prompts|answers)\.md$/, '');
    return cleanName || 'default';
}

export function loadTrailSet(trailFolder: string, setName: string, sets: Map<string, TrailSet>): TrailEntry[] {
    const set = sets.get(setName);
    if (!set) { return []; }
    
    const entries: TrailEntry[] = [];
    
    if (set.prompts) {
        const filePath = path.join(trailFolder, set.prompts);
        if (fs.existsSync(filePath)) {
            entries.push(...parseTrailFile(filePath, 'PROMPT'));
        }
    }
    
    if (set.answers) {
        const filePath = path.join(trailFolder, set.answers);
        if (fs.existsSync(filePath)) {
            entries.push(...parseTrailFile(filePath, 'ANSWER'));
        }
    }
    
    // Sort chronologically by timestamp (newest first)
    entries.sort((a, b) => {
        // Compare by raw timestamp string (ISO format)
        const cmp = b.timestamp.localeCompare(a.timestamp);
        if (cmp !== 0) { return cmp; }
        // Tie-break: answers after prompts at same timestamp
        return a.type === 'ANSWER' ? -1 : 1;
    });
    
    return entries;
}

/**
 * Parse a consolidated trail file (prompts or answers).
 * Format: === TYPE ID TIMESTAMP SEQ ===
 */
function parseTrailFile(filePath: string, expectedType: 'PROMPT' | 'ANSWER'): TrailEntry[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const entries: TrailEntry[] = [];
    
    // Split by entry markers
    const markerRe = /^===\s+(PROMPT|ANSWER)\s+(\S+)\s+(\S+)\s+(\d+)\s+===\s*$/gm;
    const markers: { type: string; requestId: string; timestamp: string; seq: number; index: number }[] = [];
    
    let match;
    while ((match = markerRe.exec(content)) !== null) {
        markers.push({
            type: match[1],
            requestId: match[2],
            timestamp: match[3],
            seq: parseInt(match[4], 10),
            index: match.index + match[0].length,
        });
    }
    
    for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
        const startIdx = marker.index;
        const endIdx = i + 1 < markers.length
            ? content.lastIndexOf('\n===', markers[i + 1].index - 10)
            : content.length;
        
        const body = content.substring(startIdx, endIdx).trim();
        const entry = parseEntryBody(body, marker.type as 'PROMPT' | 'ANSWER', marker.requestId, marker.timestamp, marker.seq);
        entries.push(entry);
    }
    
    return entries;
}

function parseEntryBody(body: string, type: 'PROMPT' | 'ANSWER', requestId: string, timestamp: string, seq: number): TrailEntry {
    const entry: TrailEntry = {
        type,
        requestId,
        timestamp,
        rawTimestamp: timestamp,
        sequence: seq,
        content: body,
    };
    
    if (type === 'PROMPT') {
        // Extract TEMPLATE: and ANSWER-WRAPPER: from the end
        const templateMatch = body.match(/\nTEMPLATE:\s*(.+)/);
        const wrapperMatch = body.match(/\nANSWER-WRAPPER:\s*(.+)/);
        if (templateMatch) {
            entry.templateName = templateMatch[1].trim();
            // Remove metadata lines from displayed content
            entry.content = body.substring(0, body.indexOf('\nTEMPLATE:')).trim();
        }
        if (wrapperMatch) {
            entry.answerWrapper = wrapperMatch[1].trim();
        }
    } else {
        // Extract metadata sections from the end
        const commentMatch = body.match(/\ncomments:\s*(.+)/);
        const variablesMatch = body.match(/\nvariables:\n([\s\S]*?)(?=\n(?:references|requestFileAttachments):|$)/);
        const referencesMatch = body.match(/\nreferences:\n([\s\S]*?)(?=\n(?:variables|requestFileAttachments):|$)/);
        const attachmentsMatch = body.match(/\nrequestFileAttachments:\n([\s\S]*?)(?=\n(?:variables|references):|$)/);
        
        if (commentMatch) { entry.comments = commentMatch[1].trim(); }
        if (variablesMatch) { entry.variables = variablesMatch[1].trim(); }
        if (referencesMatch) {
            entry.references = referencesMatch[1].split('\n')
                .map(l => l.replace(/^\s*-\s*/, '').trim())
                .filter(Boolean);
        }
        if (attachmentsMatch) {
            entry.attachments = attachmentsMatch[1].split('\n')
                .map(l => l.replace(/^\s*-\s*/, '').trim())
                .filter(Boolean);
        }
        
        // Strip metadata from displayed content
        const metaStart = body.search(/\n(?:comments|variables|references|requestFileAttachments):/);
        if (metaStart > 0) {
            entry.content = body.substring(0, metaStart).trim();
        }
    }
    
    return entry;
}

// ============================================================================
// HTML Builder
// ============================================================================

function buildHtml(
    codiconsUri: string,
    markedUri: string,
    trailSets: Map<string, TrailSet>,
    currentSet: string,
    entries: TrailEntry[],
): string {
    const setsJson = JSON.stringify(Object.fromEntries(trailSets));
    const entriesJson = JSON.stringify(entries);
    const currentSetJson = JSON.stringify(currentSet);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconsUri}">
<style>
:root {
    --sidebar-width: 320px;
    --meta-height: 200px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

/* ---- Top bar ---- */
.top-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
}
.top-bar label { font-weight: 600; white-space: nowrap; }
.top-bar select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 3px 6px;
    border-radius: 3px;
    font-size: var(--vscode-font-size);
}
.top-bar .spacer { flex: 1; }
.icon-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 14px;
}
.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }

/* ---- Main layout ---- */
.main {
    display: flex;
    flex: 1;
    overflow: hidden;
}

/* ---- Left sidebar ---- */
.sidebar {
    width: var(--sidebar-width);
    min-width: 200px;
    border-right: 1px solid var(--vscode-panel-border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
}
.entry-list {
    flex: 1;
    overflow-y: auto;
    padding: 0;
}
.entry-item {
    padding: 6px 10px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
    font-size: 11px;
    line-height: 1.4;
    display: flex;
    flex-direction: column;
    gap: 1px;
}
.entry-item:hover { background: var(--vscode-list-hoverBackground); }
.entry-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.entry-label { font-weight: 600; }
.entry-type-prompt .entry-label { color: var(--vscode-charts-blue, #4fc1ff); }
.entry-type-answer .entry-label { color: var(--vscode-charts-green, #89d185); }
.entry-item.selected .entry-label { color: inherit; }
.entry-preview {
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
}
.entry-todo-links {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 6px;
    margin-top: 2px;
}
.entry-todo-link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-size: 9px;
    text-decoration: none;
    opacity: 0.85;
}
.entry-todo-link:hover {
    text-decoration: underline;
    opacity: 1;
}
.entry-todo-link::before {
    content: '\\eb99';
    font-family: codicon;
    margin-right: 2px;
    font-size: 9px;
}

/* ---- Vertical splitter ---- */
.v-splitter {
    width: 4px;
    cursor: col-resize;
    background: var(--vscode-panel-border);
    flex-shrink: 0;
}
.v-splitter:hover, .v-splitter.dragging { background: var(--vscode-focusBorder); }

/* ---- Right panels ---- */
.right-panels {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

/* ---- Content preview ---- */
.preview-panel {
    flex: 1;
    overflow: auto;
    padding: 14px 18px;
}
.preview-panel .markdown-body h1, .preview-panel .markdown-body h2, .preview-panel .markdown-body h3 { margin: 16px 0 8px; }
.preview-panel .markdown-body p { margin: 8px 0; line-height: 1.5; }
.preview-panel .markdown-body pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 6px; overflow-x: auto; }
.preview-panel .markdown-body code { font-family: var(--vscode-editor-font-family); }
.preview-panel .markdown-body blockquote { border-left: 3px solid var(--vscode-panel-border); margin: 8px 0; padding: 4px 10px; color: var(--vscode-descriptionForeground); }
.preview-panel .markdown-body table { border-collapse: collapse; width: 100%; margin: 10px 0; }
.preview-panel .markdown-body th, .preview-panel .markdown-body td { border: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; }
.preview-panel .markdown-body hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 14px 0; }
.empty-state { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--vscode-descriptionForeground); font-style: italic; }

/* ---- Horizontal splitter ---- */
.h-splitter {
    height: 4px;
    cursor: row-resize;
    background: var(--vscode-panel-border);
    flex-shrink: 0;
}
.h-splitter:hover, .h-splitter.dragging { background: var(--vscode-focusBorder); }

/* ---- Metadata panel ---- */
.meta-panel {
    height: var(--meta-height);
    min-height: 80px;
    overflow-y: auto;
    padding: 8px 14px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    font-size: 12px;
}
.meta-panel .meta-title { font-weight: 600; margin-bottom: 6px; }
.meta-panel .meta-row { display: flex; gap: 8px; margin-bottom: 3px; }
.meta-panel .meta-key { font-weight: 600; min-width: 110px; color: var(--vscode-descriptionForeground); }
.meta-panel .meta-value { word-break: break-all; }
.meta-panel .meta-list { padding-left: 16px; margin: 2px 0; }
.meta-panel .meta-list li { margin-bottom: 1px; }
.todo-value-link {
    color: var(--vscode-textLink-foreground);
    text-decoration: underline;
    cursor: pointer;
}
.todo-value-link:hover {
    color: var(--vscode-textLink-activeForeground);
}
</style>
</head>
<body>

<!-- Top bar -->
<div class="top-bar">
    <label>Trail:</label>
    <select id="quest-select"></select>
    <span class="spacer"></span>
    <button class="icon-btn" id="btn-open-prompts" title="Open prompts file in editor"><span class="codicon codicon-file-text"></span></button>
    <button class="icon-btn" id="btn-open-answers" title="Open answers file in editor"><span class="codicon codicon-file-code"></span></button>
    <button class="icon-btn" id="btn-md-viewer" title="Open in MD viewer"><span class="codicon codicon-link-external"></span></button>
</div>

<!-- Main layout -->
<div class="main">
    <!-- Left sidebar: entry list -->
    <div class="sidebar" id="sidebar">
        <div class="entry-list" id="entry-list"></div>
    </div>

    <!-- Vertical splitter -->
    <div class="v-splitter" id="v-splitter"></div>

    <!-- Right panels -->
    <div class="right-panels" id="right-panels">
        <!-- Content preview -->
        <div class="preview-panel" id="preview-panel">
            <div class="empty-state">Select a prompt or answer to preview</div>
        </div>

        <!-- Horizontal splitter -->
        <div class="h-splitter" id="h-splitter"></div>

        <!-- Metadata panel -->
        <div class="meta-panel" id="meta-panel">
            <div class="meta-title">Metadata</div>
            <div class="empty-state" style="height:auto; padding:12px 0;">No entry selected</div>
        </div>
    </div>
</div>

<script src="${markedUri}"></script>
<script>
(function() {
    const vscode = acquireVsCodeApi();
    
    let allEntries = ${entriesJson};
    let currentQuest = ${currentSetJson};
    const trailSets = ${setsJson};
    let selectedIndex = -1;
    
    // ---- Quest dropdown ----
    const questSelect = document.getElementById('quest-select');
    function populateQuestDropdown(sets, selected) {
        questSelect.innerHTML = '';
        var names = Object.keys(sets).sort();
        for (var i = 0; i < names.length; i++) {
            var opt = document.createElement('option');
            opt.value = names[i];
            opt.textContent = names[i];
            if (names[i] === selected) { opt.selected = true; }
            questSelect.appendChild(opt);
        }
    }
    populateQuestDropdown(trailSets, currentQuest);
    
    questSelect.addEventListener('change', function() {
        currentQuest = questSelect.value;
        selectedIndex = -1;
        vscode.postMessage({ type: 'switchQuest', quest: currentQuest });
    });
    
    // ---- Entry list ----
    var entryListEl = document.getElementById('entry-list');

    function extractTodoRefsFromVars(vars) {
        if (!vars) return [];
        var refs = [];
        var lines = vars.split('\\n');
        for (var k = 0; k < lines.length; k++) {
            var line = lines[k].replace(/^\\s*-\\s*/, '').trim();
            // Match <KEY-with-TODO>=<value> — key must contain uppercase TODO
            var eqIdx = line.indexOf('=');
            if (eqIdx < 1) continue;
            var key = line.substring(0, eqIdx);
            if (key.indexOf('TODO') === -1) continue;
            var val = line.substring(eqIdx + 1).trim();
            if (val) refs.push(val);
        }
        return refs;
    }

    function formatTodoDisplay(todoPath) {
        var parts = todoPath.split('/');
        if (parts.length < 2) return todoPath;
        var todoId = parts[parts.length - 1];
        var todoFile = parts[parts.length - 2];
        return todoId + '@' + todoFile;
    }

    function formatTimestamp(ts) {
        // ts is ISO format like 2026-02-22T01:38:28.288Z or compact like 2026-02-22T01:38:28
        try {
            var d = new Date(ts);
            if (isNaN(d.getTime())) { return ts; }
            var yy = String(d.getFullYear()).slice(2);
            var mo = String(d.getMonth() + 1).padStart(2, '0');
            var dd = String(d.getDate()).padStart(2, '0');
            var hh = String(d.getHours()).padStart(2, '0');
            var mm = String(d.getMinutes()).padStart(2, '0');
            var ss = String(d.getSeconds()).padStart(2, '0');
            return yy + mo + dd + '-' + hh + mm + ss;
        } catch(e) { return ts; }
    }
    
    function renderEntryList() {
        entryListEl.innerHTML = '';
        for (var i = 0; i < allEntries.length; i++) {
            var e = allEntries[i];
            var div = document.createElement('div');
            div.className = 'entry-item entry-type-' + e.type.toLowerCase();
            if (i === selectedIndex) { div.classList.add('selected'); }
            div.setAttribute('data-index', String(i));
            
            var ts = formatTimestamp(e.timestamp);
            var label = ts + '-' + e.type + '-' + e.requestId.substring(0, 8);
            
            var labelDiv = document.createElement('div');
            labelDiv.className = 'entry-label';
            labelDiv.textContent = label;
            div.appendChild(labelDiv);
            
            var previewDiv = document.createElement('div');
            previewDiv.className = 'entry-preview';
            previewDiv.textContent = (e.content || '').substring(0, 100).replace(/\\n/g, ' ');
            div.appendChild(previewDiv);
            
            if (e.type === 'ANSWER' && e.variables) {
                var todoRefs = extractTodoRefsFromVars(e.variables);
                if (todoRefs.length > 0) {
                    var todoLinksDiv = document.createElement('div');
                    todoLinksDiv.className = 'entry-todo-links';
                    for (var t = 0; t < todoRefs.length; t++) {
                        var link = document.createElement('a');
                        link.className = 'entry-todo-link';
                        link.textContent = formatTodoDisplay(todoRefs[t]);
                        link.setAttribute('data-todopath', todoRefs[t]);
                        link.addEventListener('click', (function(ref) {
                            return function(ev) {
                                ev.stopPropagation();
                                ev.preventDefault();
                                var segs = ref.split('/');
                                var tid = segs.length >= 2 ? segs[segs.length - 1] : ref;
                                var tpath = segs.length >= 2 ? segs.slice(0, segs.length - 1).join('/') : '';
                                vscode.postMessage({ type: 'gotoTodo', todoId: tid, todoPath: tpath });
                            };
                        })(todoRefs[t]));
                        todoLinksDiv.appendChild(link);
                    }
                    div.appendChild(todoLinksDiv);
                }
            }

            div.addEventListener('click', (function(idx) { return function() { selectEntry(idx); }; })(i));
            entryListEl.appendChild(div);
        }
    }
    
    function selectEntry(idx) {
        selectedIndex = idx;
        // Update selection highlight
        var items = entryListEl.querySelectorAll('.entry-item');
        for (var j = 0; j < items.length; j++) {
            items[j].classList.toggle('selected', j === idx);
        }
        // Update preview and metadata
        var entry = allEntries[idx];
        if (!entry) { return; }
        renderPreview(entry);
        renderMeta(entry);
    }
    
    // ---- Preview ----
    var previewPanel = document.getElementById('preview-panel');
    
    function renderPreview(entry) {
        var md = entry.content || '';
        var html;
        if (typeof marked !== 'undefined' && marked.parse) {
            try { html = marked.parse(md); } catch(e) { html = '<pre>' + escapeHtml(md) + '</pre>'; }
        } else {
            html = '<pre>' + escapeHtml(md) + '</pre>';
        }
        previewPanel.innerHTML = '<div class="markdown-body">' + html + '</div>';
    }
    
    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    
    // ---- Metadata ----
    var metaPanel = document.getElementById('meta-panel');
    
    function renderMeta(entry) {
        var html = '<div class="meta-title">' + entry.type + ' Metadata</div>';
        html += metaRow('Request ID', entry.requestId);
        html += metaRow('Timestamp', entry.rawTimestamp);
        html += metaRow('Sequence', String(entry.sequence));
        
        if (entry.type === 'PROMPT') {
            html += metaRow('Template', entry.templateName || '(none)');
            html += metaRow('Answer Wrapper', entry.answerWrapper || '(none)');
        } else {
            if (entry.comments) { html += metaRow('Comment', entry.comments); }
            if (entry.variables) { html += metaVariablesRow('Chat Values', entry.variables); }
            if (entry.references && entry.references.length) {
                html += '<div class="meta-row"><div class="meta-key">References</div><div class="meta-value"><ul class="meta-list">';
                for (var i = 0; i < entry.references.length; i++) {
                    html += '<li>' + escapeHtml(entry.references[i]) + '</li>';
                }
                html += '</ul></div></div>';
            }
            if (entry.attachments && entry.attachments.length) {
                html += '<div class="meta-row"><div class="meta-key">Attachments</div><div class="meta-value"><ul class="meta-list">';
                for (var i = 0; i < entry.attachments.length; i++) {
                    html += '<li>' + escapeHtml(entry.attachments[i]) + '</li>';
                }
                html += '</ul></div></div>';
            }
        }
        
        metaPanel.innerHTML = html;
    }
    
    function metaRow(key, value) {
        return '<div class="meta-row"><div class="meta-key">' + escapeHtml(key) + '</div><div class="meta-value">' + escapeHtml(value || '') + '</div></div>';
    }
    
    function parseVariablePairs(value) {
        if (!value) return [];
        var pairs = [];
        var lines = value.split('\\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            // Strip leading YAML list marker '- '
            if (line.indexOf('- ') === 0) { line = line.substring(2).trim(); }
            if (!line) continue;
            var eqIdx = line.indexOf('=');
            if (eqIdx > 0) {
                pairs.push({ key: line.substring(0, eqIdx).trim(), val: line.substring(eqIdx + 1).trim() });
            } else {
                pairs.push({ key: line, val: '' });
            }
        }
        return pairs;
    }
    
    function metaVariablesRow(key, value) {
        var pairs = parseVariablePairs(value);
        if (pairs.length === 0) return metaRow(key, value || '');
        var html = '<div class="meta-row"><div class="meta-key">' + escapeHtml(key) + '</div><div class="meta-value"><ul class="meta-list">';
        for (var i = 0; i < pairs.length; i++) {
            var k = escapeHtml(pairs[i].key);
            var v = escapeHtml(pairs[i].val);
            if (pairs[i].key === 'TODO' && pairs[i].val) {
                // Extract todo ID from path: last segment after /
                var todoPath = pairs[i].val;
                var slashIdx = todoPath.lastIndexOf('/');
                var todoId = slashIdx >= 0 ? todoPath.substring(slashIdx + 1) : todoPath;
                html += '<li>' + k + ' = <a class="todo-value-link" data-todo-id="' + escapeHtml(todoId) + '" data-todo-path="' + v + '" href="#">' + v + '</a></li>';
            } else {
                html += '<li>' + k + ' = ' + v + '</li>';
            }
        }
        html += '</ul></div></div>';
        return html;
    }
    
    // ---- TODO link click handler ----
    metaPanel.addEventListener('click', function(e) {
        var target = e.target;
        if (target.classList && target.classList.contains('todo-value-link')) {
            e.preventDefault();
            var todoId = target.getAttribute('data-todo-id');
            var todoPath = target.getAttribute('data-todo-path');
            if (todoId) {
                vscode.postMessage({ type: 'gotoTodo', todoId: todoId, todoPath: todoPath || '' });
            }
        }
    });
    
    // ---- Splitter logic ----
    var sidebar = document.getElementById('sidebar');
    var vSplitter = document.getElementById('v-splitter');
    var hSplitter = document.getElementById('h-splitter');
    var rightPanels = document.getElementById('right-panels');
    
    // Vertical splitter (left column width)
    var vDragging = false;
    vSplitter.addEventListener('mousedown', function(e) {
        vDragging = true;
        vSplitter.classList.add('dragging');
        e.preventDefault();
    });
    
    // Horizontal splitter (meta panel height)
    var hDragging = false;
    hSplitter.addEventListener('mousedown', function(e) {
        hDragging = true;
        hSplitter.classList.add('dragging');
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', function(e) {
        if (vDragging) {
            var newWidth = Math.max(200, Math.min(e.clientX, window.innerWidth - 300));
            sidebar.style.width = newWidth + 'px';
            document.documentElement.style.setProperty('--sidebar-width', newWidth + 'px');
        }
        if (hDragging) {
            var rpRect = rightPanels.getBoundingClientRect();
            var newMetaHeight = Math.max(80, Math.min(rpRect.bottom - e.clientY, rpRect.height - 100));
            metaPanel.style.height = newMetaHeight + 'px';
            document.documentElement.style.setProperty('--meta-height', newMetaHeight + 'px');
        }
    });
    
    document.addEventListener('mouseup', function() {
        if (vDragging) { vDragging = false; vSplitter.classList.remove('dragging'); }
        if (hDragging) { hDragging = false; hSplitter.classList.remove('dragging'); }
    });
    
    // ---- Toolbar buttons ----
    document.getElementById('btn-open-prompts').addEventListener('click', function() {
        vscode.postMessage({ type: 'openInEditor', quest: currentQuest, fileType: 'prompts' });
    });
    document.getElementById('btn-open-answers').addEventListener('click', function() {
        vscode.postMessage({ type: 'openInEditor', quest: currentQuest, fileType: 'answers' });
    });
    document.getElementById('btn-md-viewer').addEventListener('click', function() {
        vscode.postMessage({ type: 'openInMdViewer', quest: currentQuest, fileType: 'prompts' });
    });
    
    // ---- Message handler ----
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.type === 'updateEntries') {
            allEntries = msg.entries || [];
            if (msg.quest) { currentQuest = msg.quest; }
            if (msg.trailSets) { populateQuestDropdown(msg.trailSets, currentQuest); }
            selectedIndex = -1;
            renderEntryList();
            previewPanel.innerHTML = '<div class="empty-state">Select a prompt or answer to preview</div>';
            metaPanel.innerHTML = '<div class="meta-title">Metadata</div><div class="empty-state" style="height:auto;padding:12px 0;">No entry selected</div>';
        }
    });
    
    // ---- Initial render ----
    renderEntryList();
    if (allEntries.length > 0) {
        selectEntry(0);
    }
})();
</script>
</body>
</html>`;
}
