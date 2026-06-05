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
import { readMediaText } from '../utils/webviewLoader.js';
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
            'tomAi.trailViewer',
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
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
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
        debugLog(`[TrailEditor] resolveCustomTextEditor openedFile=${openedFile}`, 'INFO', 'trailEditor');

        // Discover all trail sets (quest name -> { prompts, answers })
        const trailSets = ensureTrailSetForOpenedFile(discoverTrailSetsAcrossWorkspace(trailFolder), basename, trailFolder);
        const currentSet = identifyCurrentSet(basename, trailSets);
        let activeSet = currentSet;
        let activeTrailSets = trailSets;
        debugLog(`[TrailEditor] discovered sets=${JSON.stringify(Object.fromEntries(trailSets))} currentSet=${currentSet}`, 'INFO', 'trailEditor');

        // Parse entries from the current set
        const entries = loadTrailSet(currentSet, trailSets);
        const entriesBySet = buildEntriesBySet(trailSets);
        debugLog(`[TrailEditor] initial entries count=${entries.length} for set=${currentSet}`, 'INFO', 'trailEditor');

        // Check for pending focus (e.g. from TODO-LOG click)
        const pendingFocus = this.context.workspaceState.get<{ requestId: string; session: string }>('tomAi.trailEditor.pendingFocus');
        if (pendingFocus && pendingFocus.requestId) {
            // Clear immediately so it doesn't fire again
            this.context.workspaceState.update('tomAi.trailEditor.pendingFocus', undefined);
            // Delay slightly to let the webview script initialise
            setTimeout(() => {
                webviewPanel.webview.postMessage({
                    type: 'focusEntry',
                    requestId: pendingFocus.requestId,
                });
            }, 300);
        }

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'clientReady': {
                        debugLog(`[TrailEditor] clientReady quest=${String(message.quest || '')} entries=${String(message.entries ?? '')}`, 'INFO', 'trailEditor.client');
                        break;
                    }
                    case 'clientError': {
                        debugLog(`[TrailEditor] clientError where=${String(message.where || '')} error=${String(message.error || '')} stack=${String(message.stack || '')}`, 'ERROR', 'trailEditor.client');
                        break;
                    }
                    case 'switchQuest': {
                        activeSet = message.quest || activeSet;
                        debugLog(`[TrailEditor] switchQuest requested set=${String(message.quest || '')} resolved set=${activeSet}`, 'INFO', 'trailEditor');
                        const setName = activeTrailSets.has(activeSet)
                            ? activeSet
                            : firstTrailSetName(activeTrailSets) ?? activeSet;
                        activeSet = setName;
                        const newEntries = loadTrailSet(activeSet, activeTrailSets);
                        debugLog(`[TrailEditor] switchQuest loaded entries=${newEntries.length} activeSet=${activeSet}`, 'INFO', 'trailEditor');
                        webviewPanel.webview.postMessage({
                            type: 'updateEntries',
                            entries: newEntries,
                            entriesBySet: buildEntriesBySet(activeTrailSets),
                            quest: activeSet,
                            trailSets: Object.fromEntries(activeTrailSets),
                        });
                        break;
                    }
                    case 'openInEditor': {
                        const set = activeTrailSets.get(message.quest || currentSet);
                        if (set) {
                            const file = message.fileType === 'prompts' ? set.prompts : set.answers;
                            if (file) {
                                const filePath = path.join(set.directory || trailFolder, file);
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
                        const set = activeTrailSets.get(message.quest || currentSet);
                        if (set) {
                            const file = message.fileType === 'prompts' ? set.prompts : set.answers;
                            if (file) {
                                const filePath = path.join(set.directory || trailFolder, file);
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

        const trailBaseUri = webviewPanel.webview
            .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'trailEditor'))
            .toString()
            .replace(/\/$/, '');

        webviewPanel.webview.html = buildHtml(
            webviewPanel.webview.cspSource,
            trailBaseUri,
            webviewCodiconsUri.toString(),
            webviewMarkedUri.toString(),
            trailSets,
            currentSet,
            entries,
            entriesBySet,
        );

        // Watch trail folder for changes
        const watcher = fs.watch(trailFolder, (_eventType, filename) => {
            if (filename && (filename.endsWith('.prompts.md') || filename.endsWith('.answers.md'))) {
                debugLog(`[TrailEditor] fs.watch change filename=${filename}`, 'INFO', 'trailEditor');
                activeTrailSets = ensureTrailSetForOpenedFile(discoverTrailSetsAcrossWorkspace(trailFolder), basename, trailFolder);
                if (!activeTrailSets.has(activeSet)) {
                    activeSet = firstTrailSetName(activeTrailSets) ?? activeSet;
                }
                const updatedEntries = loadTrailSet(activeSet, activeTrailSets);
                debugLog(`[TrailEditor] watcher update sets=${JSON.stringify(Object.fromEntries(activeTrailSets))} activeSet=${activeSet} entries=${updatedEntries.length}`, 'INFO', 'trailEditor');
                webviewPanel.webview.postMessage({
                    type: 'updateEntries',
                    entries: updatedEntries,
                    entriesBySet: buildEntriesBySet(activeTrailSets),
                    quest: activeSet,
                    trailSets: Object.fromEntries(activeTrailSets),
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
    directory?: string; // absolute folder path containing the files
}

function ensureTrailSetForOpenedFile(sets: Map<string, TrailSet>, basename: string, openedFolder: string): Map<string, TrailSet> {
    const inferredSet = basename.replace(/\.(prompts|answers)\.md$/, '').trim();
    if (!inferredSet) {
        return sets;
    }

    const existing = sets.get(inferredSet) ?? { directory: openedFolder };
    if (basename.endsWith('.prompts.md')) {
        existing.prompts = basename;
    }
    if (basename.endsWith('.answers.md')) {
        existing.answers = basename;
    }
    if (!existing.directory) {
        existing.directory = openedFolder;
    }
    sets.set(inferredSet, existing);
    return sets;
}

function firstTrailSetName(sets: Map<string, TrailSet>): string | undefined {
    for (const [name] of sets) {
        return name;
    }
    return undefined;
}

function discoverTrailSetsAcrossWorkspace(openedFolder: string): Map<string, TrailSet> {
    const merged = new Map<string, TrailSet>();
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const mergeFromFolder = (folderPath: string): void => {
        if (!folderPath || !fs.existsSync(folderPath)) {
            return;
        }
        const localSets = discoverTrailSets(folderPath);
        for (const [setName, set] of localSets) {
            if (merged.has(setName)) {
                continue;
            }
            merged.set(setName, {
                prompts: set.prompts,
                answers: set.answers,
                directory: folderPath,
            });
        }
    };

    mergeFromFolder(openedFolder);

    if (!wsRoot) {
        return merged;
    }

    const questsRoot = path.join(wsRoot, '_ai', 'quests');
    if (!fs.existsSync(questsRoot)) {
        return merged;
    }

    const entries = fs.readdirSync(questsRoot, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        mergeFromFolder(path.join(questsRoot, entry.name));
    }

    return merged;
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

        await ctx.workspaceState.update('tomAi.questTodo.pendingSelect', {
            file: yamlRelPath,
            todoId: todoId,
        });
        const uri = vscode.Uri.file(yamlAbsPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'tomAi.todoEditor');
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
        .replace(/\.(prompts|answers)\.md$/, '');
    return cleanName || 'default';
}

export function loadTrailSet(setName: string, sets: Map<string, TrailSet>): TrailEntry[] {
    const set = sets.get(setName);
    if (!set) { return []; }

    const trailFolder = set.directory;
    if (!trailFolder) { return []; }
    
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

function buildEntriesBySet(sets: Map<string, TrailSet>): Record<string, TrailEntry[]> {
    const out: Record<string, TrailEntry[]> = {};
    for (const [setName] of sets) {
        out[setName] = loadTrailSet(setName, sets);
    }
    return out;
}

/**
 * Parse a consolidated trail file (prompts or answers).
 * Format: === TYPE ID TIMESTAMP SEQ ===
 */
function parseTrailFile(filePath: string, expectedType: 'PROMPT' | 'ANSWER'): TrailEntry[] {
    const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
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

    if (entries.length === 0 && content.trim().length > 0) {
        return parseFallbackSummaryContent(content, expectedType);
    }
    
    return entries;
}

function parseFallbackSummaryContent(content: string, expectedType: 'PROMPT' | 'ANSWER'): TrailEntry[] {
    const chunks = content
        .split(/\n\s*---\s*\n/g)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    const out: TrailEntry[] = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const marker = chunk.match(/requestId\"\s*:\s*\"([^\"]+)\"|REQUEST-ID:\s*([^\n\r]+)/i);
        const requestId = (marker?.[1] || marker?.[2] || `fallback_${i + 1}`).trim();
        const tsMatch = chunk.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/);
        const timestamp = tsMatch?.[1] || new Date(0).toISOString();

        const entry: TrailEntry = {
            type: expectedType,
            requestId,
            timestamp,
            rawTimestamp: timestamp,
            sequence: chunks.length - i,
            content: chunk,
        };

        if (expectedType === 'PROMPT') {
            const templateMatch = chunk.match(/(?:^|\n)TEMPLATE:\s*(.+)/);
            const wrapperMatch = chunk.match(/(?:^|\n)ANSWER-WRAPPER:\s*(.+)/);
            if (templateMatch) {
                entry.templateName = templateMatch[1].trim();
            }
            if (wrapperMatch) {
                entry.answerWrapper = wrapperMatch[1].trim();
            }
            const metaStart = chunk.search(/(?:^|\n)(?:TEMPLATE:|ANSWER-WRAPPER:|REQUEST-ID:)/);
            if (metaStart > 0) {
                entry.content = chunk.substring(0, metaStart).trim();
            }
        } else {
            // Check for ### metadata JSON block (localLlm / lmApi format)
            const metaJsonMatch = chunk.match(/(?:^|\n)### metadata\s*\n```json\n([\s\S]*?)```\s*\n*([\s\S]*)$/);
            if (metaJsonMatch) {
                try {
                    const meta = JSON.parse(metaJsonMatch[1]);
                    if (meta.profile) { entry.comments = `profile: ${meta.profile}`; }
                    if (meta.llmConfigKey) {
                        entry.comments = (entry.comments ? entry.comments + ', ' : '') + `config: ${meta.llmConfigKey}`;
                    }
                    entry.variables = Object.entries(meta)
                        .map(([k, v]) => `${k} = ${String(v)}`)
                        .join('\n');
                } catch { /* ignore parse errors */ }
                entry.content = (metaJsonMatch[2] || '').trim();
            } else {
                const commentMatch = chunk.match(/(?:^|\n)comments:\s*(.+)/);
                const variablesMatch = chunk.match(/(?:^|\n)variables:\n([\s\S]*?)(?=\n(?:references|requestFileAttachments):|$)/);
                const referencesMatch = chunk.match(/(?:^|\n)references:\n([\s\S]*?)(?=\n(?:variables|requestFileAttachments):|$)/);
                const attachmentsMatch = chunk.match(/(?:^|\n)requestFileAttachments:\n([\s\S]*?)(?=\n(?:variables|references):|$)/);
                if (commentMatch) { entry.comments = commentMatch[1].trim(); }
                if (variablesMatch) { entry.variables = variablesMatch[1].trim(); }
                if (referencesMatch) {
                    entry.references = referencesMatch[1].split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
                }
                if (attachmentsMatch) {
                    entry.attachments = attachmentsMatch[1].split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
                }
                const metaStart = chunk.search(/(?:^|\n)(?:comments|variables|references|requestFileAttachments):/);
                if (metaStart > 0) {
                    entry.content = chunk.substring(0, metaStart).trim();
                }
            }
        }

        out.push(entry);
    }
    return out;
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
        // Check for ### metadata JSON block (used by localLlm and lmApi trails)
        const metaJsonMatch = body.match(/^### metadata\s*\n```json\n([\s\S]*?)```\s*\n*([\s\S]*)$/);
        if (metaJsonMatch) {
            try {
                const meta = JSON.parse(metaJsonMatch[1]);
                if (meta.profile) { entry.comments = `profile: ${meta.profile}`; }
                if (meta.llmConfigKey) {
                    entry.comments = (entry.comments ? entry.comments + ', ' : '') + `config: ${meta.llmConfigKey}`;
                }
                // Store full metadata as variables for display in metadata panel
                entry.variables = Object.entries(meta)
                    .map(([k, v]) => `${k} = ${String(v)}`)
                    .join('\n');
            } catch { /* ignore parse errors */ }
            entry.content = (metaJsonMatch[2] || '').trim();
        } else {
            // Extract metadata sections from the end (copilot format)
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
    }
    
    return entry;
}

// ============================================================================
// HTML Builder
// ============================================================================

function buildHtml(
    cspSource: string,
    baseUri: string,
    codiconsUri: string,
    markedUri: string,
    trailSets: Map<string, TrailSet>,
    currentSet: string,
    entries: TrailEntry[],
    entriesBySet: Record<string, TrailEntry[]>,
): string {
    const safeJson = (value: unknown): string => JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/`/g, '\\u0060')
        .replace(/\$/g, '\\u0024')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');

    const setsObject = Object.fromEntries(trailSets);
    const setsJson = safeJson(setsObject);
    const entriesJson = safeJson(entries);
    const entriesBySetJson = safeJson(entriesBySet);
    const currentSetJson = safeJson(currentSet);

    const splitSetName = (setName: string): { quest: string; subsystem: string } => {
        const idx = setName.lastIndexOf('.');
        if (idx < 0) {
            return { quest: setName, subsystem: 'unknown' };
        }
        return {
            quest: setName.substring(0, idx) || setName,
            subsystem: setName.substring(idx + 1) || 'unknown',
        };
    };

    const setNames = Object.keys(setsObject).sort();
    const selectedSet = setNames.includes(currentSet) ? currentSet : (setNames[0] ?? '');
    const questSubsystemIndex = new Map<string, Array<{ subsystem: string; setName: string }>>();
    for (const setName of setNames) {
        const parsed = splitSetName(setName);
        if (!questSubsystemIndex.has(parsed.quest)) {
            questSubsystemIndex.set(parsed.quest, []);
        }
        questSubsystemIndex.get(parsed.quest)!.push({ subsystem: parsed.subsystem, setName });
    }

    const selectedParsed = selectedSet ? splitSetName(selectedSet) : { quest: 'unknown', subsystem: 'unknown' };
    const selectedQuest = selectedParsed.quest;
    const selectedSubsystems = (questSubsystemIndex.get(selectedQuest) ?? []).slice().sort((a, b) => a.subsystem.localeCompare(b.subsystem));

    const escapeAttr = (value: string): string => value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const initialQuestOptionsHtml = Array.from(questSubsystemIndex.keys())
        .sort((a, b) => a.localeCompare(b))
        .map((questName) => `<option value="${escapeAttr(questName)}"${questName === selectedQuest ? ' selected' : ''}>${escapeAttr(questName)}</option>`)
        .join('');

    const initialSubsystemOptionsHtml = selectedSubsystems
        .map((sub) => `<option value="${escapeAttr(sub.setName)}"${sub.setName === selectedSet ? ' selected' : ''}>${escapeAttr(sub.subsystem)}</option>`)
        .join('');

    const escapeHtml = (value: string): string => value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const formatTimestamp = (ts: string): string => {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) {
            return ts;
        }
        const yy = String(d.getFullYear()).slice(2);
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${yy}${mo}${dd}-${hh}${mm}${ss}`;
    };

    const initialEntryListHtml = entries.map((entry, index) => {
        const label = `${formatTimestamp(entry.timestamp)}-${entry.type}-${entry.requestId.substring(0, 8)}`;
        const preview = (entry.content || '').substring(0, 100).replace(/\n/g, ' ');
        const selectedCls = index === 0 ? ' selected' : '';
        return `<div class="entry-item entry-type-${entry.type.toLowerCase()}${selectedCls}" data-index="${index}">`
            + `<div class="entry-label">${escapeHtml(label)}</div>`
            + `<div class="entry-preview">${escapeHtml(preview)}</div>`
            + `</div>`;
    }).join('');

    const firstEntry = entries.length > 0 ? entries[0] : undefined;
    const initialPreviewHtml = firstEntry
        ? `<div class="markdown-body"><pre>${escapeHtml(firstEntry.content || '')}</pre></div>`
        : '<div class="empty-state">Select a prompt or answer to preview</div>';

    const initialMetaRows = firstEntry
        ? [
            `<div class="meta-title">${escapeHtml(firstEntry.type)} Metadata</div>`,
            `<div class="meta-row"><div class="meta-key">Request ID</div><div class="meta-value">${escapeHtml(firstEntry.requestId)}</div></div>`,
            `<div class="meta-row"><div class="meta-key">Timestamp</div><div class="meta-value">${escapeHtml(firstEntry.rawTimestamp)}</div></div>`,
            `<div class="meta-row"><div class="meta-key">Sequence</div><div class="meta-value">${escapeHtml(String(firstEntry.sequence))}</div></div>`,
            firstEntry.type === 'PROMPT'
                ? `<div class="meta-row"><div class="meta-key">Template</div><div class="meta-value">${escapeHtml(firstEntry.templateName || '(none)')}</div></div>`
                : '',
            firstEntry.type === 'PROMPT'
                ? `<div class="meta-row"><div class="meta-key">Answer Wrapper</div><div class="meta-value">${escapeHtml(firstEntry.answerWrapper || '(none)')}</div></div>`
                : '',
        ].join('')
        : '<div class="meta-title">Metadata</div><div class="empty-state" style="height:auto; padding:12px 0;">No entry selected</div>';

    // Compose the externalized shell (media/trailEditor/index.html) by
    // substituting the server-rendered first-paint regions and JSON data
    // blocks. Uses the readMediaText escape hatch + split/join token
    // substitution (NOT loadWebviewHtml) because this panel server-renders
    // dynamic content into the shell — same pattern as B.19/B.21/B.22.
    const tokens: Record<string, string> = {
        '{{cspSource}}': cspSource,
        '{{codiconsUri}}': codiconsUri,
        '{{markedUri}}': markedUri,
        '{{baseUri}}': baseUri,
        '{{questOptions}}': initialQuestOptionsHtml,
        '{{subsystemOptions}}': initialSubsystemOptionsHtml,
        '{{entryList}}': initialEntryListHtml,
        '{{preview}}': initialPreviewHtml,
        '{{metaRows}}': initialMetaRows,
        '{{entriesJson}}': entriesJson,
        '{{entriesBySetJson}}': entriesBySetJson,
        '{{setsJson}}': setsJson,
        '{{currentSetJson}}': currentSetJson,
    };

    let html = readMediaText('trailEditor', 'index.html');
    for (const [token, value] of Object.entries(tokens)) {
        html = html.split(token).join(value);
    }
    return html;
}
