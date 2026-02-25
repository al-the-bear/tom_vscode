/**
 * Prompt Trail Viewer - View historical prompt/answer exchanges from trail folders
 * 
 * A webview panel that displays exchanges from trail folders:
 * - Lists exchanges (grouped by requestId)
 * - Shows prompt and answer files for each exchange
 * - Allows extracting content to markdown files
 * - Supports opening extracted markdown in editor or external app
 * 
 * Trail file naming patterns:
 *   New format (primary):
 *     YYYYMMDD_HHMMSSmmm_prompt_<requestId>.userprompt.md
 *     YYYYMMDD_HHMMSSmmm_answer_<requestId>.answer.json
 *   
 *   Old format (legacy):
 *     YYYYMMDD_HHMMSS_<session>.userprompt.md
 *     YYYYMMDD_HHMMSS_<session>.answer.md
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WsPaths } from '../utils/workspacePaths';
import { openInExternalApplication } from './handler_shared';
import { readWorkspaceTodos } from '../managers/questTodoManager.js';
import { selectTodoInBottomPanel } from './questTodoPanel-handler.js';

// ============================================================================
// Types
// ============================================================================

export interface TrailFile {
    filename: string;
    type: 'userprompt' | 'answer';
    fullPath: string;
    isJson?: boolean;  // True for .answer.json files
}

export interface TrailExchange {
    id: string;  // requestId (new format) or YYYYMMDD_HHMMSS_session (old format)
    timestamp: string;  // YYYYMMDD_HHMMSS or YYYYMMDD_HHMMSSmmm
    session: string;  // requestId or session name
    displayTime: string;  // Formatted for display
    files: TrailFile[];
    todoRefs?: string[];  // TODO references extracted from answer files
}

// ============================================================================
// Trail File Parsing
// ============================================================================

export interface ParsedTrailFile {
    timestamp: string;
    requestId: string;
    type: 'userprompt' | 'answer';
    isJson: boolean;
}

/**
 * Parse a trail filename into its components.
 * Supports both new and old formats.
 */
export function parseTrailFilename(filename: string): ParsedTrailFile | null {
    // New format: YYYYMMDD_HHMMSSmmm_prompt_<requestId>.userprompt.md
    // New format: YYYYMMDD_HHMMSSmmm_answer_<requestId>.answer.json
    const newFormatMatch = filename.match(/^(\d{8}_\d{9})_(prompt|answer)_([^.]+)\.(userprompt\.md|answer\.json)$/);
    if (newFormatMatch) {
        const isAnswer = newFormatMatch[2] === 'answer';
        return {
            timestamp: newFormatMatch[1],
            requestId: newFormatMatch[3],
            type: isAnswer ? 'answer' : 'userprompt',
            isJson: newFormatMatch[4] === 'answer.json',
        };
    }
    
    // Old format: YYYYMMDD_HHMMSS_session.userprompt.md or YYYYMMDD_HHMMSS_session.answer.md
    const oldFormatMatch = filename.match(/^(\d{8}_\d{6})_([^.]+)\.(userprompt|answer)\.md$/);
    if (oldFormatMatch) {
        return {
            timestamp: oldFormatMatch[1],
            requestId: `${oldFormatMatch[1]}_${oldFormatMatch[2]}`,  // Use timestamp_session as ID
            type: oldFormatMatch[3] as 'userprompt' | 'answer',
            isJson: false,
        };
    }
    
    return null;
}

/**
 * Format timestamp for display.
 * Handles both YYYYMMDD_HHMMSS and YYYYMMDD_HHMMSSmmm formats.
 */
export function formatTimestamp(timestamp: string): string {
    const date = timestamp.slice(0, 8);
    const time = timestamp.slice(9);
    const hours = time.slice(0, 2);
    const minutes = time.slice(2, 4);
    const seconds = time.slice(4, 6);
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${hours}:${minutes}:${seconds}`;
}

/**
 * Scan a trail folder and group files into exchanges by requestId.
 */
export function loadTrailExchanges(trailFolder: string): TrailExchange[] {
    if (!fs.existsSync(trailFolder)) {
        return [];
    }
    
    const files = fs.readdirSync(trailFolder).filter(f => 
        f.endsWith('.userprompt.md') || f.endsWith('.answer.md') || f.endsWith('.answer.json')
    );
    
    // Group by requestId
    const exchangeMap = new Map<string, TrailExchange>();
    
    for (const filename of files) {
        const parsed = parseTrailFilename(filename);
        if (!parsed) continue;
        
        const exchangeId = parsed.requestId;
        
        if (!exchangeMap.has(exchangeId)) {
            exchangeMap.set(exchangeId, {
                id: exchangeId,
                timestamp: parsed.timestamp,
                session: parsed.requestId,
                displayTime: formatTimestamp(parsed.timestamp),
                files: [],
            });
        }
        
        exchangeMap.get(exchangeId)!.files.push({
            filename,
            type: parsed.type,
            fullPath: path.join(trailFolder, filename),
            isJson: parsed.isJson,
        });
    }
    
    // Extract TODO refs from answer files for each exchange
    for (const exchange of exchangeMap.values()) {
        const refs: string[] = [];
        for (const file of exchange.files) {
            if (file.type === 'answer' && file.isJson) {
                try {
                    const raw = fs.readFileSync(file.fullPath, 'utf-8');
                    const json = JSON.parse(raw);
                    if (json?.responseValues && typeof json.responseValues === 'object') {
                        for (const [key, value] of Object.entries(json.responseValues as Record<string, unknown>)) {
                            // Case-sensitive: key must contain uppercase "TODO"
                            if (key.indexOf('TODO') !== -1 && typeof value === 'string' && value.trim()) {
                                refs.push(value.trim());
                            }
                        }
                    }
                } catch { /* ignore read/parse errors */ }
            }
        }
        if (refs.length > 0) {
            exchange.todoRefs = refs;
        }
    }

    // Sort exchanges by timestamp (most recent first)
    return Array.from(exchangeMap.values())
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Read file content safely.
 * For JSON answer files, extracts the generatedMarkdown field.
 */
function readFileContent(filePath: string, isJson: boolean = false): string {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (isJson) {
            try {
                const json = JSON.parse(content);
                // Extract generatedMarkdown from answer JSON
                if (json.generatedMarkdown) {
                    return json.generatedMarkdown;
                }
                // Fallback: return formatted JSON
                return `\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;
            } catch {
                return content;  // Return raw content if JSON parse fails
            }
        }
        return content;
    } catch {
        return `Error reading file: ${filePath}`;
    }
}

function readAnswerJsonData(filePath: string): {
    markdown: string;
    todoRef?: string;
    responseValues?: Record<string, string>;
} {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        const markdown = parsed?.generatedMarkdown
            ? String(parsed.generatedMarkdown)
            : `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
        const responseValues: Record<string, string> = {};
        if (parsed?.responseValues && typeof parsed.responseValues === 'object') {
            for (const [key, value] of Object.entries(parsed.responseValues as Record<string, unknown>)) {
                if (typeof value === 'string' && value.trim()) {
                    responseValues[key] = value.trim();
                }
            }
        }
        const todoKeys = Object.keys(responseValues).filter((key) => key.includes('TODO'));
        let todoRef = todoKeys.length > 0 ? responseValues[todoKeys[0]] : undefined;
        if (!todoRef) {
            todoRef = extractTodoRefFromText(markdown);
        }
        return {
            markdown,
            todoRef,
            responseValues: Object.keys(responseValues).length > 0 ? responseValues : undefined,
        };
    } catch {
        const markdown = readFileContent(filePath, false);
        const responseValues = extractResponseValuesFromText(markdown);
        const todoKeys = Object.keys(responseValues).filter((key) => key.includes('TODO'));
        const todoRef = todoKeys.length > 0
            ? responseValues[todoKeys[0]]
            : extractTodoRefFromText(markdown);
        return {
            markdown,
            todoRef,
            responseValues: Object.keys(responseValues).length > 0 ? responseValues : undefined,
        };
    }
}

function extractResponseValuesFromText(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!text) return out;

    const jsonResponseBlock = text.match(/"responseValues"\s*:\s*\{([\s\S]*?)\}/i);
    if (jsonResponseBlock?.[1]) {
        const pairRegex = /"([^"]+)"\s*:\s*"([^"]*)"/g;
        let match: RegExpExecArray | null;
        while ((match = pairRegex.exec(jsonResponseBlock[1])) !== null) {
            const key = (match[1] || '').trim();
            const value = (match[2] || '').trim();
            if (key && value) out[key] = value;
        }
    }

    const yamlResponseValuesRegex = /^\s*responseValues\s*:\s*$(?:\n^\s{2,}[^\n]+)+/im;
    const yamlResponseBlock = text.match(yamlResponseValuesRegex);
    if (yamlResponseBlock?.[0]) {
        const lines = yamlResponseBlock[0].split(/\r?\n/);
        for (const line of lines.slice(1)) {
            const pair = line.match(/^\s{2,}([A-Za-z0-9_.-]+)\s*:\s*(.+)\s*$/);
            if (!pair) continue;
            const key = pair[1].trim();
            const value = pair[2].trim().replace(/^['"]|['"]$/g, '');
            if (key && value) out[key] = value;
        }
    }

    const variablesBlockRegex = /^\s*variables\s*:\s*$(?:\n^\s*[-*]\s*[^\n]+)+/im;
    const variablesBlock = text.match(variablesBlockRegex);
    if (variablesBlock?.[0]) {
        const lines = variablesBlock[0].split(/\r?\n/);
        for (const line of lines.slice(1)) {
            const eqPair = line.match(/^\s*[-*]\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)\s*$/);
            if (eqPair) {
                const key = eqPair[1].trim();
                const value = eqPair[2].trim().replace(/^['"]|['"]$/g, '');
                if (key && value) out[key] = value;
                continue;
            }
            const colonPair = line.match(/^\s*[-*]\s*([A-Za-z0-9_.-]+)\s*:\s*(.+)\s*$/);
            if (colonPair) {
                const key = colonPair[1].trim();
                const value = colonPair[2].trim().replace(/^['"]|['"]$/g, '');
                if (key && value) out[key] = value;
            }
        }
    }

    return out;
}

function extractTodoRefFromText(text: string): string | undefined {
    if (!text) return undefined;
    const patterns = [
        /"TODO"\s*:\s*"([^"]+)"/i,
        /responseValues\.[Tt][Oo][Dd][Oo]\s*[:=]\s*"?([^"\n]+)"?/i,
        /\bTODO\b\s*[:=]\s*"?([^"\n]+)"?/i,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            const value = match[1].trim();
            if (value) return value;
        }
    }
    return undefined;
}

// ============================================================================
// Webview Panel
// ============================================================================

const VIEW_TYPE = 'dartscript.trailViewer';

let currentPanel: vscode.WebviewPanel | undefined;

/**
 * Open or focus the Trail Viewer panel.
 */
export async function openTrailViewer(
    context: vscode.ExtensionContext,
    trailFolder?: string
): Promise<void> {
    const folder = trailFolder || WsPaths.ai('trail');
    
    if (!folder || !fs.existsSync(folder)) {
        vscode.window.showWarningMessage(`Trail folder not found: ${folder || '_ai/trail'}`);
        return;
    }
    
    // If panel exists, just reveal it
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        currentPanel.webview.postMessage({ type: 'refresh', folder });
        return;
    }
    
    // Create new panel
    currentPanel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        'Prompt Trail Viewer',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        }
    );
    
    currentPanel.webview.html = getWebviewHtml(currentPanel.webview, context.extensionUri, folder);
    
    // Handle messages from webview
    currentPanel.webview.onDidReceiveMessage(
        message => handleMessage(message, currentPanel!.webview, folder as string, context),
        undefined,
        context.subscriptions
    );
    
    // Clean up on dispose
    currentPanel.onDidDispose(
        () => { currentPanel = undefined; },
        undefined,
        context.subscriptions
    );
}

/**
 * Handle messages from the webview.
 */
async function handleMessage(
    message: any,
    webview: vscode.Webview,
    currentFolder: string,
    context: vscode.ExtensionContext,
): Promise<void> {
    switch (message.type) {
        case 'loadExchanges':
            const exchanges = loadTrailExchanges(currentFolder);
            webview.postMessage({ type: 'exchanges', exchanges });
            break;
            
        case 'loadExchange':
            const exchange = loadTrailExchanges(currentFolder).find(s => s.id === message.exchangeId);
            if (exchange) {
                const content: Record<string, string> = {};
                let todoRef: string | undefined;
                let responseValues: Record<string, string> | undefined;
                for (const file of exchange.files) {
                    if (file.type === 'answer' && file.isJson) {
                        const parsed = readAnswerJsonData(file.fullPath);
                        content[file.type] = parsed.markdown;
                        if (parsed.responseValues) {
                            responseValues = parsed.responseValues;
                        }
                        if (parsed.todoRef) {
                            todoRef = parsed.todoRef;
                        }
                    } else {
                        content[file.type] = readFileContent(file.fullPath, file.isJson);
                        if (file.type === 'answer' && !todoRef) {
                            todoRef = extractTodoRefFromText(content[file.type]);
                        }
                        if (file.type === 'answer' && !responseValues) {
                            const parsedResponseValues = extractResponseValuesFromText(content[file.type]);
                            if (Object.keys(parsedResponseValues).length > 0) {
                                responseValues = parsedResponseValues;
                            }
                        }
                    }
                }
                webview.postMessage({
                    type: 'exchangeContent',
                    exchangeId: exchange.id,
                    content,
                    todoRef,
                    responseValues,
                });
            }
            break;

        case 'gotoTodo':
            await gotoWorkspaceTodo(String(message.todoRef || ''), context);
            break;
            
        case 'extractToMarkdown':
            await extractToMarkdown(message.exchangeId, message.content, currentFolder);
            break;
            
        case 'openInEditor':
            await openMarkdownInEditor(message.exchangeId, message.content);
            break;
            
        case 'openExternally':
            await openMarkdownExternally(message.exchangeId, message.content);
            break;
            
        case 'openFile':
            const uri = vscode.Uri.file(message.filePath);
            await vscode.window.showTextDocument(uri);
            break;
    }
}

export async function gotoWorkspaceTodo(todoRefRaw: string, _context: vscode.ExtensionContext): Promise<void> {
    const todoRef = todoRefRaw.trim();
    if (!todoRef) {
        vscode.window.showWarningMessage('TODO not found');
        return;
    }

    // Extract todoId from the full path (last segment)
    let todoId = todoRef;
    const slashIdx = todoRef.lastIndexOf('/');
    if (slashIdx > 0) {
        todoId = todoRef.substring(slashIdx + 1);
    }

    // Extract quest ID and file name from the path portion
    // Ref format: _ai/quests/<questId>/<filename>.todo.yaml/<todoId>
    let questId: string | undefined;
    let fileName: string | undefined;
    if (slashIdx > 0) {
        const pathPart = todoRef.substring(0, slashIdx);
        // Match _ai/quests/<questId>/<file>
        const questMatch = pathPart.match(/(?:^|\/|\\)_ai[\/\\]quests[\/\\]([^\/\\]+)[\/\\]([^\/\\]+)$/);
        if (questMatch) {
            questId = questMatch[1];
            fileName = questMatch[2];
        } else {
            // Fallback: just use the last segment before the todoId as the file name
            const lastSlash2 = pathPart.lastIndexOf('/');
            if (lastSlash2 >= 0) {
                fileName = pathPart.substring(lastSlash2 + 1);
            } else {
                fileName = pathPart;
            }
        }
    }

    // Try bottom panel first (T3 Quest TODO accordion)
    try {
        const selected = await selectTodoInBottomPanel(todoId, fileName, questId);
        if (selected) return;
    } catch { /* fall through */ }

    // Fallback: find and open in editor
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
        vscode.window.showWarningMessage('TODO not found');
        return;
    }

    const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
    let sourcePath: string | undefined;
    if (slashIdx > 0) {
        sourcePath = normalize(todoRef.substring(0, slashIdx));
    }

    const all = readWorkspaceTodos();
    const found = all.find((t) => {
        if (t.id !== todoId) return false;
        if (!sourcePath) return true;
        const src = normalize(t._sourceFile || '');
        return src === sourcePath || src.endsWith('/' + sourcePath);
    });

    if (!found || !found._sourceFile) {
        vscode.window.showWarningMessage('TODO not found');
        return;
    }

    const absPath = path.join(wsRoot, found._sourceFile);
    if (!fs.existsSync(absPath)) {
        vscode.window.showWarningMessage('TODO not found');
        return;
    }

    const uri = vscode.Uri.file(absPath);
    try {
        await vscode.commands.executeCommand('vscode.openWith', uri, 'questTodo.editor');
    } catch {
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const text = doc.getText();
        const idx = text.indexOf(`id: ${todoId}`);
        if (idx >= 0) {
            const pos = doc.positionAt(idx);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
    }
}

/**
 * Extract session content to a markdown file.
 */
/**
 * Build combined markdown from exchange content.
 */
function buildExchangeMarkdown(
    exchangeId: string,
    content: { userprompt?: string; answer?: string },
): string {
    let markdown = `# Trail Exchange: ${exchangeId}\n\n`;
    
    if (content.userprompt) {
        markdown += `## User Prompt\n\n${content.userprompt}\n\n`;
    }
    
    if (content.answer) {
        markdown += `## Answer\n\n${content.answer}\n\n`;
    }
    
    return markdown;
}

/**
 * Write exchange markdown to a temporary file and return the path.
 */
function writeTempMarkdown(exchangeId: string, content: { userprompt?: string; answer?: string }): string {
    const markdown = buildExchangeMarkdown(exchangeId, content);
    const tmpDir = path.join(os.tmpdir(), 'tom-trail-viewer');
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }
    const tmpFile = path.join(tmpDir, `trail_${exchangeId}.md`);
    fs.writeFileSync(tmpFile, markdown, 'utf-8');
    return tmpFile;
}

async function extractToMarkdown(
    exchangeId: string,
    content: { userprompt?: string; answer?: string },
    trailFolder: string
): Promise<void> {
    const markdown = buildExchangeMarkdown(exchangeId, content);
    
    // Prompt for save location
    const defaultUri = vscode.Uri.file(
        path.join(path.dirname(trailFolder), `trail_${exchangeId}.md`)
    );
    
    const saveUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { 'Markdown': ['md'] },
        title: 'Save Trail Exchange as Markdown',
    });
    
    if (saveUri) {
        fs.writeFileSync(saveUri.fsPath, markdown, 'utf-8');
        vscode.window.showInformationMessage(`Trail saved: ${path.basename(saveUri.fsPath)}`);
        await vscode.window.showTextDocument(saveUri);
    }
}

/**
 * Open exchange markdown in VS Code editor (temporary file).
 */
async function openMarkdownInEditor(
    exchangeId: string,
    content: { userprompt?: string; answer?: string },
): Promise<void> {
    const tmpFile = writeTempMarkdown(exchangeId, content);
    const uri = vscode.Uri.file(tmpFile);
    await vscode.window.showTextDocument(uri);
}

/**
 * Open exchange markdown in external application (temporary file).
 */
async function openMarkdownExternally(
    exchangeId: string,
    content: { userprompt?: string; answer?: string },
): Promise<void> {
    const tmpFile = writeTempMarkdown(exchangeId, content);
    await openInExternalApplication(tmpFile);
}

// ============================================================================
// Webview HTML
// ============================================================================

function getWebviewHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    trailFolder: string
): string {
    const codiconsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
    );
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; font-src ${webview.cspSource};">
    <link href="${codiconsUri}" rel="stylesheet" />
    <title>Trail Viewer</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            overflow: hidden;
        }
        
        /* Sidebar */
        .sidebar {
            width: 280px;
            min-width: 200px;
            display: flex;
            flex-direction: column;
            background: var(--vscode-sideBar-background);
        }

        /* Vertical splitter */
        .v-splitter {
            width: 4px;
            cursor: col-resize;
            background: var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .v-splitter:hover, .v-splitter.dragging { background: var(--vscode-focusBorder); }
        .sidebar-header {
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .sidebar-header h2 {
            font-size: 14px;
            font-weight: 600;
            flex: 1;
        }
        .sidebar-header button {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 4px;
        }
        .sidebar-header button:hover {
            color: var(--vscode-textLink-foreground);
        }
        
        /* Session List */
        .session-list {
            flex: 1;
            overflow-y: auto;
            padding: 4px 0;
        }
        .session-item {
            padding: 8px 12px;
            cursor: pointer;
            border-left: 3px solid transparent;
        }
        .session-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .session-item.selected {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
            border-left-color: var(--vscode-focusBorder);
        }
        .session-time {
            font-size: 12px;
            font-weight: 600;
        }
        .session-name {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
        }
        .session-files {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
        }
        .session-todo-links {
            display: flex;
            flex-wrap: wrap;
            gap: 2px 6px;
            margin-top: 3px;
        }
        .session-todo-link {
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            font-size: 9px;
            text-decoration: none;
            opacity: 0.85;
        }
        .session-todo-link:hover {
            text-decoration: underline;
            opacity: 1;
        }
        
        /* Content */
        .content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .content-header {
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .content-header h2 {
            font-size: 14px;
            font-weight: 600;
            flex: 1;
        }
        .btn {
            padding: 4px 10px;
            font-size: 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        /* Tabs */
        .tabs {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-tab-inactiveBackground);
        }
        .tab {
            padding: 8px 16px;
            cursor: pointer;
            border-bottom: 2px solid transparent;
            font-size: 12px;
        }
        .tab:hover {
            background: var(--vscode-tab-hoverBackground);
        }
        .tab.active {
            background: var(--vscode-tab-activeBackground);
            border-bottom-color: var(--vscode-focusBorder);
        }
        
        /* Content Pane */
        .content-pane {
            flex: 1;
            overflow: auto;
            padding: 16px;
        }
        .content-pane pre {
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            line-height: 1.5;
            background: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 4px;
        }
        .answer-metadata {
            margin-bottom: 12px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            background: var(--vscode-editor-background);
            overflow: hidden;
        }
        .answer-metadata-title {
            padding: 8px 10px;
            font-size: 12px;
            font-weight: 600;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBarSectionHeader-background);
        }
        .answer-metadata-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .answer-metadata-row:last-child {
            border-bottom: none;
        }
        .answer-metadata-key {
            min-width: 200px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .answer-metadata-value {
            flex: 1;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            word-break: break-all;
        }
        .todo-value-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: underline;
            cursor: pointer;
        }
        .todo-value-link:hover {
            color: var(--vscode-textLink-activeForeground);
        }
        .todo-value-icon {
            margin-left: 6px;
            color: var(--vscode-textLink-foreground);
            display: inline-flex;
            align-items: center;
        }
        
        /* Empty State */
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
        }
        .empty-state .codicon {
            font-size: 48px;
            margin-bottom: 16px;
        }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="sidebar-header">
            <h2>Exchanges</h2>
            <button id="refreshBtn" title="Refresh"><span class="codicon codicon-refresh"></span></button>
        </div>
        <div class="session-list" id="sessionList">
            <div class="empty-state">
                <span class="codicon codicon-loading codicon-modifier-spin"></span>
                <div>Loading sessions...</div>
            </div>
        </div>
    </div>
    
    <div class="v-splitter" id="vSplitter"></div>

    <div class="content">
        <div class="content-header">
            <h2 id="exchangeTitle">Select an exchange</h2>
            <button class="btn icon-btn" id="gotoTodoBtn" style="display: none;" title="Open TODO in @WS QUEST TODOS">
                <span class="codicon codicon-tasklist"></span>
            </button>
            <button class="btn icon-btn" id="openInEditorBtn" style="display: none;" title="Open as Markdown in Editor">
                <span class="codicon codicon-file-code"></span>
            </button>
            <button class="btn icon-btn" id="openExternallyBtn" style="display: none;" title="Open in MD viewer">
                <span class="codicon codicon-link-external"></span>
            </button>
            <button class="btn" id="extractBtn" style="display: none;">
                <span class="codicon codicon-file-text"></span>
                Extract to Markdown
            </button>
        </div>
        <div class="tabs" id="tabs" style="display: none;">
            <div class="tab active" data-tab="prompt">Prompt</div>
            <div class="tab" data-tab="answer">Answer</div>
        </div>
        <div class="content-pane" id="contentPane">
            <div class="empty-state">
                <span class="codicon codicon-history"></span>
                <div>Select an exchange to view its content</div>
            </div>
        </div>
    </div>
    
    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            let exchanges = [];
            let selectedExchange = null;
            let exchangeContent = {};
            let exchangeTodoRef = '';
            let exchangeResponseValues = null;
            let currentTab = 'prompt';
            
            // Elements
            const exchangeList = document.getElementById('sessionList');
            const exchangeTitle = document.getElementById('exchangeTitle');
            const tabs = document.getElementById('tabs');
            const contentPane = document.getElementById('contentPane');
            const extractBtn = document.getElementById('extractBtn');
            const gotoTodoBtn = document.getElementById('gotoTodoBtn');
            const openInEditorBtn = document.getElementById('openInEditorBtn');
            const openExternallyBtn = document.getElementById('openExternallyBtn');
            const refreshBtn = document.getElementById('refreshBtn');
            
            // Render exchange list
            function renderExchanges() {
                if (exchanges.length === 0) {
                    exchangeList.innerHTML = '<div class="empty-state"><span class="codicon codicon-info"></span><div>No trail exchanges found in this folder.</div></div>';
                    return;
                }
                
                exchangeList.innerHTML = exchanges.map(s => {
                    const fileTypes = s.files.map(f => f.type).join(', ');
                    let todoHtml = '';
                    if (s.todoRefs && s.todoRefs.length > 0) {
                        const links = s.todoRefs.map(ref => {
                            const parts = ref.split('/');
                            const todoId = parts.length >= 2 ? parts[parts.length - 1] : ref;
                            const todoFile = parts.length >= 2 ? parts[parts.length - 2] : '';
                            const display = todoFile ? todoId + '@' + todoFile : todoId;
                            const encoded = encodeURIComponent(ref);
                            return '<a class="session-todo-link" data-todoref="' + encoded + '" title="Open TODO in @WS QUEST TODOS">' + escapeHtml(display) + '</a>';
                        }).join('');
                        todoHtml = '<div class="session-todo-links">' + links + '</div>';
                    }
                    return \`
                        <div class="session-item\${s.id === selectedExchange?.id ? ' selected' : ''}" data-id="\${s.id}">
                            <div class="session-time">\${s.displayTime}</div>
                            <div class="session-name">\${s.session}</div>
                            <div class="session-files">\${fileTypes}</div>
                            \${todoHtml}
                        </div>\`;
                }).join('');
                
                // Add click handlers
                exchangeList.querySelectorAll('.session-item').forEach(el => {
                    el.addEventListener('click', () => selectExchange(el.dataset.id));
                });
                // Add TODO link click handlers (stop propagation)
                exchangeList.querySelectorAll('.session-todo-link').forEach(link => {
                    link.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                        const todoRef = decodeURIComponent(link.getAttribute('data-todoref') || '');
                        if (todoRef) {
                            vscode.postMessage({ type: 'gotoTodo', todoRef });
                        }
                    });
                });
            }
            
            // Select an exchange
            function selectExchange(id) {
                selectedExchange = exchanges.find(s => s.id === id);
                if (!selectedExchange) return;
                
                renderExchanges();
                exchangeTitle.textContent = selectedExchange.displayTime + ' - ' + selectedExchange.session;
                tabs.style.display = 'flex';
                extractBtn.style.display = 'flex';
                gotoTodoBtn.style.display = 'none';
                
                // Request content
                vscode.postMessage({ type: 'loadExchange', exchangeId: id });
            }
            
            // Render content pane
            function renderContent() {
                const content = exchangeContent[currentTab] || '';
                if (!content) {
                    contentPane.innerHTML = '<div class="empty-state"><span class="codicon codicon-file"></span><div>No ' + currentTab + ' content</div></div>';
                } else {
                    const metadataHtml = currentTab === 'answer' ? renderAnswerMetadata() : '';
                    contentPane.innerHTML = metadataHtml + '<pre>' + escapeHtml(content) + '</pre>';
                }
            }

            function renderAnswerMetadata() {
                if (!exchangeResponseValues || typeof exchangeResponseValues !== 'object') {
                    return '';
                }
                const entries = Object.entries(exchangeResponseValues);
                if (!entries.length) {
                    return '';
                }
                const rows = entries.map(([key, value]) => {
                    const keyText = 'responseValues.' + key;
                    const encodedTodoRef = encodeURIComponent(value);
                    const hasTodoKey = key.includes('TODO');
                    const renderedValue = hasTodoKey
                        ? '<a href="#" class="todo-value-link" title="Open TODO in @WS QUEST TODOS" data-todoref="' + encodedTodoRef + '">' + escapeHtml(String(value)) + '</a><span class="todo-value-icon codicon codicon-tasklist" aria-hidden="true"></span>'
                        : escapeHtml(String(value));
                    return '<div class="answer-metadata-row">'
                        + '<div class="answer-metadata-key">' + escapeHtml(keyText) + '</div>'
                        + '<div class="answer-metadata-value">' + renderedValue + '</div>'
                        + '</div>';
                }).join('');
                return '<div class="answer-metadata">'
                    + '<div class="answer-metadata-title">ANSWER Metadata</div>'
                    + rows
                    + '</div>';
            }
            
            // Escape HTML
            function escapeHtml(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }
            
            // Tab switching
            tabs.addEventListener('click', (e) => {
                const tab = e.target.closest('.tab');
                if (!tab) return;
                
                currentTab = tab.dataset.tab;
                tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                renderContent();
            });

            contentPane.addEventListener('click', (e) => {
                const todoLink = e.target.closest('.todo-value-link');
                if (!todoLink) return;
                e.preventDefault();
                const encodedRef = todoLink.getAttribute('data-todoref') || '';
                const todoRef = decodeURIComponent(encodedRef);
                if (!todoRef) return;
                vscode.postMessage({
                    type: 'gotoTodo',
                    todoRef,
                });
            });
            
            // Extract button
            extractBtn.addEventListener('click', () => {
                if (!selectedExchange) return;
                vscode.postMessage({
                    type: 'extractToMarkdown',
                    exchangeId: selectedExchange.id,
                    content: {
                        userprompt: exchangeContent.prompt,
                        answer: exchangeContent.answer,
                    },
                });
            });

            gotoTodoBtn.addEventListener('click', () => {
                if (!exchangeTodoRef) return;
                vscode.postMessage({
                    type: 'gotoTodo',
                    todoRef: exchangeTodoRef,
                });
            });
            
            // Open in Editor button
            openInEditorBtn.addEventListener('click', () => {
                if (!selectedExchange) return;
                vscode.postMessage({
                    type: 'openInEditor',
                    exchangeId: selectedExchange.id,
                    content: {
                        userprompt: exchangeContent.prompt,
                        answer: exchangeContent.answer,
                    },
                });
            });
            
            // Open Externally button
            openExternallyBtn.addEventListener('click', () => {
                if (!selectedExchange) return;
                vscode.postMessage({
                    type: 'openExternally',
                    exchangeId: selectedExchange.id,
                    content: {
                        userprompt: exchangeContent.prompt,
                        answer: exchangeContent.answer,
                    },
                });
            });
            
            // Refresh button
            refreshBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'loadExchanges' });
            });
            
            // Handle messages from extension
            window.addEventListener('message', (event) => {
                const message = event.data;
                switch (message.type) {
                    case 'exchanges':
                        exchanges = message.exchanges;
                        renderExchanges();
                        break;
                        
                    case 'exchangeContent':
                        exchangeContent = {
                            prompt: message.content.userprompt || '',
                            answer: message.content.answer || '',
                        };
                        exchangeResponseValues = message.responseValues || null;
                        exchangeTodoRef = message.todoRef || '';
                        gotoTodoBtn.style.display = exchangeTodoRef ? 'flex' : 'none';
                        renderContent();
                        break;
                        
                    case 'refresh':
                        vscode.postMessage({ type: 'loadExchanges' });
                        break;
                }
            });
            
            // Initial load
            vscode.postMessage({ type: 'loadExchanges' });

            // ── Splitter logic ──
            (function() {
                const sidebar = document.querySelector('.sidebar');
                const vSplitter = document.getElementById('vSplitter');
                let vDragging = false;
                vSplitter.addEventListener('mousedown', function(e) {
                    vDragging = true;
                    vSplitter.classList.add('dragging');
                    e.preventDefault();
                });
                document.addEventListener('mousemove', function(e) {
                    if (vDragging) {
                        const newWidth = Math.max(180, Math.min(e.clientX, window.innerWidth - 300));
                        sidebar.style.width = newWidth + 'px';
                    }
                });
                document.addEventListener('mouseup', function() {
                    if (vDragging) { vDragging = false; vSplitter.classList.remove('dragging'); }
                });
            })();
        })();
    </script>
</body>
</html>`;
}

// ============================================================================
// Command Registration
// ============================================================================

export function registerTrailViewerCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('dartscript.openTrailViewer', () => 
            openTrailViewer(context)
        ),
        vscode.commands.registerCommand('dartscript.openTrailViewerFolder', async () => {
            // Allow user to select a trail folder
            const folder = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                title: 'Select Trail Folder',
            });
            
            if (folder && folder[0]) {
                await openTrailViewer(context, folder[0].fsPath);
            }
        }),
    ];
}
