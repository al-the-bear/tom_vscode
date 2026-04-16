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

        webviewPanel.webview.html = buildHtml(
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
    <strong style="margin-right:8px">Summary Viewer</strong>
    <label>Trail:</label>
    <select id="quest-select">${initialQuestOptionsHtml}</select>
    <label>Subsystem:</label>
    <select id="subsystem-select">${initialSubsystemOptionsHtml}</select>
    <span class="spacer"></span>
    <button class="icon-btn" id="btn-open-prompts" title="Open prompts file in editor"><span class="codicon codicon-file-text"></span></button>
    <button class="icon-btn" id="btn-open-answers" title="Open answers file in editor"><span class="codicon codicon-file-code"></span></button>
    <button class="icon-btn" id="btn-md-viewer" title="Open in MD viewer"><span class="codicon codicon-link-external"></span></button>
</div>

<!-- Main layout -->
<div class="main">
    <!-- Left sidebar: entry list -->
    <div class="sidebar" id="sidebar">
        <div class="entry-list" id="entry-list">${initialEntryListHtml}</div>
    </div>

    <!-- Vertical splitter -->
    <div class="v-splitter" id="v-splitter"></div>

    <!-- Right panels -->
    <div class="right-panels" id="right-panels">
        <!-- Content preview -->
        <div class="preview-panel" id="preview-panel">
            ${initialPreviewHtml}
        </div>

        <!-- Horizontal splitter -->
        <div class="h-splitter" id="h-splitter"></div>

        <!-- Metadata panel -->
        <div class="meta-panel" id="meta-panel">
            ${initialMetaRows}
        </div>
    </div>
</div>

<script id="trail-data-entries" type="application/json">${entriesJson}</script>
<script id="trail-data-entries-by-set" type="application/json">${entriesBySetJson}</script>
<script id="trail-data-sets" type="application/json">${setsJson}</script>
<script id="trail-data-current-set" type="application/json">${currentSetJson}</script>
<script src="${markedUri}"></script>
<script>
(function() {
    function readJsonData(scriptId, fallback) {
        try {
            var el = document.getElementById(scriptId);
            if (!el) { return fallback; }
            var raw = el.textContent || '';
            if (!raw) { return fallback; }
            return JSON.parse(raw);
        } catch (_err) {
            return fallback;
        }
    }

    let vscode;
    try {
    vscode = (window.__trailVscodeApi) || acquireVsCodeApi();
    window.__trailVscodeApi = vscode;
    vscode.postMessage({ type: 'clientReady', quest: 'primary-script', entries: -1 });
    
    let allEntries = readJsonData('trail-data-entries', []);
    let entriesBySet = readJsonData('trail-data-entries-by-set', {});
    let currentQuest = readJsonData('trail-data-current-set', 'unknown');
    let trailSets = readJsonData('trail-data-sets', {});
    let selectedIndex = -1;
    if (!entriesBySet || typeof entriesBySet !== 'object') {
        entriesBySet = {};
    }
    if (!entriesBySet[currentQuest]) {
        entriesBySet[currentQuest] = allEntries;
    }
    
    // ---- Quest/subsystem dropdowns ----
    const questSelect = document.getElementById('quest-select');
    const subsystemSelect = document.getElementById('subsystem-select');

    function normalizeSetName(setName, fallbackName) {
        var value = (setName || '').trim();
        if (value.length > 0) {
            return value;
        }
        var fallback = (fallbackName || currentQuest || 'unknown').trim();
        return fallback.length > 0 ? fallback : 'unknown';
    }

    function splitSetName(setName) {
        var normalized = normalizeSetName(setName, 'unknown');
        var idx = normalized.lastIndexOf('.');
        if (idx < 0) {
            return { quest: normalized, subsystem: 'unknown' };
        }
        return {
            quest: normalized.substring(0, idx) || normalized,
            subsystem: normalized.substring(idx + 1) || 'unknown'
        };
    }

    function ensureTrailSets(sets, selectedSetName) {
        if (sets && Object.keys(sets).length > 0) {
            return sets;
        }
        var fallbackName = normalizeSetName(selectedSetName, currentQuest || 'unknown');
        var fallback = {};
        fallback[fallbackName] = {};
        return fallback;
    }

    function buildQuestSubsystemIndex(sets) {
        var names = Object.keys(sets || {});
        var idx = {};
        for (var i = 0; i < names.length; i++) {
            var setName = normalizeSetName(names[i], currentQuest || 'unknown');
            var parsed = splitSetName(setName);
            if (!idx[parsed.quest]) {
                idx[parsed.quest] = [];
            }
            idx[parsed.quest].push({ subsystem: parsed.subsystem, setName: setName });
        }
        var quests = Object.keys(idx);
        function subsystemRank(name) {
            if (name === 'unknown') return 0;
            if (name === 'copilot') return 2;
            return 1;
        }
        for (var q = 0; q < quests.length; q++) {
            idx[quests[q]].sort(function(a, b) {
                var rankCmp = subsystemRank(a.subsystem) - subsystemRank(b.subsystem);
                if (rankCmp !== 0) {
                    return rankCmp;
                }
                return a.subsystem.localeCompare(b.subsystem);
            });
        }
        return idx;
    }

    function resolveSelection(sets, selectedSetName) {
        var names = Object.keys(sets || {}).map(function(n) { return normalizeSetName(n, selectedSetName || currentQuest || 'unknown'); }).sort();
        if (names.length === 0) {
            return { quest: '', subsystem: '', setName: '' };
        }
        var chosen = selectedSetName && sets[selectedSetName] ? selectedSetName : names[0];
        chosen = normalizeSetName(chosen, names[0]);
        var parsed = splitSetName(chosen);
        return { quest: parsed.quest, subsystem: parsed.subsystem, setName: chosen };
    }

    function populateSelectors(sets, selectedSetName) {
        sets = ensureTrailSets(sets, selectedSetName);
        trailSets = sets;
        var selection = resolveSelection(sets, selectedSetName);
        var index = buildQuestSubsystemIndex(sets);

        questSelect.innerHTML = '';
        var questNames = Object.keys(index).sort();
        if (questNames.length === 0) {
            var parsedFallback = splitSetName(selection.setName || currentQuest || 'unknown');
            var fallbackQuest = parsedFallback.quest || 'unknown';
            var fallbackSubsystem = parsedFallback.subsystem || 'unknown';
            index[fallbackQuest] = [{ subsystem: fallbackSubsystem, setName: normalizeSetName(selection.setName, fallbackQuest + '.' + fallbackSubsystem) }];
            questNames = [fallbackQuest];
        }
        for (var i = 0; i < questNames.length; i++) {
            var opt = document.createElement('option');
            opt.value = questNames[i];
            opt.textContent = questNames[i];
            if (questNames[i] === selection.quest) { opt.selected = true; }
            questSelect.appendChild(opt);
        }

        subsystemSelect.innerHTML = '';
        var selectedQuest = selection.quest || questNames[0] || 'unknown';
        var subs = index[selectedQuest] || [];
        if (subs.length === 0) {
            subs = [{ subsystem: 'unknown', setName: normalizeSetName(selection.setName, selectedQuest + '.unknown') }];
        }
        for (var s = 0; s < subs.length; s++) {
            var subOpt = document.createElement('option');
            subOpt.value = subs[s].setName;
            subOpt.textContent = subs[s].subsystem;
            if (subs[s].setName === selection.setName) { subOpt.selected = true; }
            subsystemSelect.appendChild(subOpt);
        }

        currentQuest = normalizeSetName(selection.setName, subs[0].setName);
        if (!subsystemSelect.value || subsystemSelect.value !== currentQuest) {
            subsystemSelect.value = currentQuest;
        }
    }

    populateSelectors(trailSets, currentQuest);

    function applyCurrentSetEntries() {
        allEntries = entriesBySet[currentQuest] || [];
        renderEntryList();
        if (allEntries.length > 0) {
            selectEntry(0);
        } else {
            selectedIndex = -1;
            previewPanel.innerHTML = '<div class="empty-state">Select a prompt or answer to preview</div>';
            metaPanel.innerHTML = '<div class="meta-title">Metadata</div><div class="empty-state" style="height:auto;padding:12px 0;">No entry selected</div>';
        }
    }

    questSelect.addEventListener('change', function() {
        var index = buildQuestSubsystemIndex(trailSets);
        var subs = index[questSelect.value] || [];
        if (subs.length === 0) {
            return;
        }

        var preferredIdx = 0;
        for (var si = 0; si < subs.length; si++) {
            if (subs[si].subsystem === 'unknown') {
                preferredIdx = si;
                break;
            }
        }

        subsystemSelect.innerHTML = '';
        for (var s = 0; s < subs.length; s++) {
            var subOpt = document.createElement('option');
            subOpt.value = subs[s].setName;
            subOpt.textContent = subs[s].subsystem;
            subsystemSelect.appendChild(subOpt);
        }

        currentQuest = subs[preferredIdx].setName;
        subsystemSelect.value = currentQuest;
        selectedIndex = -1;
        applyCurrentSetEntries();
    });

    subsystemSelect.addEventListener('change', function() {
        currentQuest = subsystemSelect.value;
        selectedIndex = -1;
        applyCurrentSetEntries();
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
            if (msg.entriesBySet && typeof msg.entriesBySet === 'object') {
                entriesBySet = msg.entriesBySet;
            }
            if (msg.quest) { currentQuest = msg.quest; }
            if (msg.trailSets) {
                trailSets = msg.trailSets;
            }
            if (!entriesBySet[currentQuest]) {
                entriesBySet[currentQuest] = msg.entries || [];
            }
            populateSelectors(trailSets, currentQuest);
            applyCurrentSetEntries();
        } else if (msg.type === 'focusEntry') {
            var targetId = msg.requestId || '';
            if (targetId) {
                for (var fi = 0; fi < allEntries.length; fi++) {
                    if (allEntries[fi].requestId === targetId) {
                        selectEntry(fi);
                        var items = entryListEl.querySelectorAll('.entry-item');
                        if (items[fi]) { items[fi].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
                        break;
                    }
                }
            }
        }
    });
    
    // ---- Initial render ----
    window.__trailPrimaryActive = true;
    renderEntryList();
    if (allEntries.length > 0) {
        selectEntry(0);
    }
    vscode.postMessage({ type: 'clientReady', quest: currentQuest, entries: allEntries.length });
    } catch (error) {
        try {
            if (vscode && typeof vscode.postMessage === 'function') {
                vscode.postMessage({
                    type: 'clientError',
                    where: 'trailEditor:init',
                    error: (error && error.message) ? error.message : String(error),
                    stack: (error && error.stack) ? error.stack : '',
                });
            }
        } catch (_ignored) {
            // no-op
        }
    }
})();
</script>
<script>
(function() {
        function readJsonData(scriptId, fallback) {
            try {
                var el = document.getElementById(scriptId);
                if (!el) { return fallback; }
                var raw = el.textContent || '';
                if (!raw) { return fallback; }
                return JSON.parse(raw);
            } catch (_err) {
                return fallback;
            }
        }

    if (window.__trailPrimaryActive) {
        return;
    }

    if (window.__trailSwitchFallbackInit) {
        return;
    }
    window.__trailSwitchFallbackInit = true;

    var vscodeApi = null;
    try {
        if (window.__trailVscodeApi && typeof window.__trailVscodeApi.postMessage === 'function') {
            vscodeApi = window.__trailVscodeApi;
        } else if (typeof acquireVsCodeApi === 'function') {
            vscodeApi = acquireVsCodeApi();
            window.__trailVscodeApi = vscodeApi;
        }
        if (vscodeApi && typeof vscodeApi.postMessage === 'function') {
            vscodeApi.postMessage({ type: 'clientReady', quest: 'fallback-script', entries: -1 });
        }
    } catch (_e) {
        vscodeApi = null;
    }

    if (!vscodeApi || typeof vscodeApi.postMessage !== 'function') {
        return;
    }

    var questSelect = document.getElementById('quest-select');
    var subsystemSelect = document.getElementById('subsystem-select');
    var entryListEl = document.getElementById('entry-list');
    var previewPanel = document.getElementById('preview-panel');
    var metaPanel = document.getElementById('meta-panel');
    if (!questSelect || !subsystemSelect || !entryListEl || !previewPanel || !metaPanel) {
        return;
    }

    var trailSets = readJsonData('trail-data-sets', {});
    var currentSet = readJsonData('trail-data-current-set', 'unknown');
    var allEntries = readJsonData('trail-data-entries', []);
    var selectedIndex = -1;

    function normalizeSetName(value) {
        var v = (value || '').trim();
        return v || 'unknown';
    }

    function splitSetName(setName) {
        var normalized = normalizeSetName(setName);
        var idx = normalized.lastIndexOf('.');
        if (idx < 0) {
            return { quest: normalized, subsystem: 'unknown' };
        }
        return {
            quest: normalized.substring(0, idx) || normalized,
            subsystem: normalized.substring(idx + 1) || 'unknown',
        };
    }

    function listQuestNames() {
        var names = Object.keys(trailSets || {});
        var quests = {};
        for (var i = 0; i < names.length; i++) {
            quests[splitSetName(names[i]).quest] = true;
        }
        return Object.keys(quests).sort();
    }

    function getSetsForQuest(questName) {
        var names = Object.keys(trailSets || {});
        var out = [];
        for (var i = 0; i < names.length; i++) {
            var parsed = splitSetName(names[i]);
            if (parsed.quest === questName) {
                out.push({ setName: names[i], subsystem: parsed.subsystem });
            }
        }
        out.sort(function(a, b) {
            function rank(name) {
                if (name === 'unknown') return 0;
                if (name === 'copilot') return 2;
                return 1;
            }
            var rankCmp = rank(a.subsystem) - rank(b.subsystem);
            if (rankCmp !== 0) return rankCmp;
            return a.subsystem.localeCompare(b.subsystem);
        });
        return out;
    }

    function populateQuestDropdown(selectedQuest) {
        var quests = listQuestNames();
        var preferred = selectedQuest;
        if (!preferred || quests.indexOf(preferred) < 0) {
            preferred = quests.length > 0 ? quests[0] : 'unknown';
        }
        questSelect.innerHTML = '';
        for (var i = 0; i < quests.length; i++) {
            var opt = document.createElement('option');
            opt.value = quests[i];
            opt.textContent = quests[i];
            if (quests[i] === preferred) {
                opt.selected = true;
            }
            questSelect.appendChild(opt);
        }
        return preferred;
    }

    function populateSubsystemDropdown(questName, preferredSetName) {
        var subs = getSetsForQuest(questName);
        subsystemSelect.innerHTML = '';
        for (var i = 0; i < subs.length; i++) {
            var opt = document.createElement('option');
            opt.value = subs[i].setName;
            opt.textContent = subs[i].subsystem;
            subsystemSelect.appendChild(opt);
        }
        if (subs.length === 0) {
            currentSet = 'unknown';
            return currentSet;
        }
        var next = subs[0].setName;
        if (preferredSetName) {
            for (var j = 0; j < subs.length; j++) {
                if (subs[j].setName === preferredSetName) {
                    next = subs[j].setName;
                    break;
                }
            }
        }
        subsystemSelect.value = next;
        currentSet = next;
        return next;
    }

    function escapeHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function formatTs(ts) {
        var d = new Date(ts);
        if (isNaN(d.getTime())) {
            return String(ts || '');
        }
        var yy = String(d.getFullYear()).slice(2);
        var mo = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        var ss = String(d.getSeconds()).padStart(2, '0');
        return yy + mo + dd + '-' + hh + mm + ss;
    }

    function renderMeta(entry) {
        var html = '<div class="meta-title">' + escapeHtml(entry.type) + ' Metadata</div>';
        html += '<div class="meta-row"><div class="meta-key">Request ID</div><div class="meta-value">' + escapeHtml(entry.requestId) + '</div></div>';
        html += '<div class="meta-row"><div class="meta-key">Timestamp</div><div class="meta-value">' + escapeHtml(entry.rawTimestamp) + '</div></div>';
        html += '<div class="meta-row"><div class="meta-key">Sequence</div><div class="meta-value">' + escapeHtml(String(entry.sequence)) + '</div></div>';
        if (entry.type === 'PROMPT') {
            html += '<div class="meta-row"><div class="meta-key">Template</div><div class="meta-value">' + escapeHtml(entry.templateName || '(none)') + '</div></div>';
            html += '<div class="meta-row"><div class="meta-key">Answer Wrapper</div><div class="meta-value">' + escapeHtml(entry.answerWrapper || '(none)') + '</div></div>';
        }
        metaPanel.innerHTML = html;
    }

    function selectEntry(idx) {
        selectedIndex = idx;
        var items = entryListEl.querySelectorAll('.entry-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('selected', i === idx);
        }
        var entry = allEntries[idx];
        if (!entry) {
            return;
        }
        previewPanel.innerHTML = '<div class="markdown-body"><pre>' + escapeHtml(entry.content || '') + '</pre></div>';
        renderMeta(entry);
    }

    function renderEntries() {
        entryListEl.innerHTML = '';
        for (var i = 0; i < allEntries.length; i++) {
            var e = allEntries[i];
            var div = document.createElement('div');
            div.className = 'entry-item entry-type-' + String(e.type || '').toLowerCase();
            var label = document.createElement('div');
            label.className = 'entry-label';
            label.textContent = formatTs(e.timestamp) + '-' + e.type + '-' + String(e.requestId || '').substring(0, 8);
            var prev = document.createElement('div');
            prev.className = 'entry-preview';
            prev.textContent = String(e.content || '').substring(0, 100).replace(/\n/g, ' ');
            div.appendChild(label);
            div.appendChild(prev);
            (function(index) {
                div.addEventListener('click', function() {
                    selectEntry(index);
                });
            })(i);
            entryListEl.appendChild(div);
        }
        if (allEntries.length > 0) {
            selectEntry(0);
        } else {
            previewPanel.innerHTML = '<div class="empty-state">No entries available for this quest/subsystem</div>';
            metaPanel.innerHTML = '<div class="meta-title">Metadata</div><div class="empty-state" style="height:auto;padding:12px 0;">No entry selected</div>';
        }
    }

    function switchToSet(setName) {
        currentSet = normalizeSetName(setName);
        vscodeApi.postMessage({ type: 'switchQuest', quest: currentSet });
    }

    questSelect.addEventListener('change', function() {
        var setName = populateSubsystemDropdown(questSelect.value, null);
        switchToSet(setName);
    });

    subsystemSelect.addEventListener('change', function() {
        switchToSet(subsystemSelect.value);
    });

    window.addEventListener('message', function(event) {
        var msg = event.data || {};
        if (msg.type === 'updateEntries') {
            if (msg.trailSets) {
                trailSets = msg.trailSets;
            }
            allEntries = msg.entries || [];
            currentSet = normalizeSetName(msg.quest || currentSet);
            var parsed = splitSetName(currentSet);
            var selectedQuest = populateQuestDropdown(parsed.quest);
            populateSubsystemDropdown(selectedQuest, currentSet);
            renderEntries();
        }
    });

    var startParsed = splitSetName(currentSet);
    var startQuest = populateQuestDropdown(startParsed.quest);
    populateSubsystemDropdown(startQuest, currentSet);
    renderEntries();
})();
</script>
</body>
</html>`;
}
