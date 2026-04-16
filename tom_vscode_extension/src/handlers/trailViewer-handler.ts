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
import { TomAiConfiguration } from '../utils/tomAiConfiguration';
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
 * Parse a raw trail filename into its components.
 * Supports canonical format only.
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

const VIEW_TYPE = 'tomAi.trailViewer';

let currentPanel: vscode.WebviewPanel | undefined;
let currentViewerState: TrailViewerState | undefined;
let currentWatcher: fs.FSWatcher | undefined;
let currentWatchedFolder: string | undefined;
let pendingRefreshTimer: NodeJS.Timeout | undefined;

interface TrailViewerFolderOption {
    id: string;
    label: string;
    folder: string;
}

/** Discovered subsystem with its quest subfolders */
interface DiscoveredSubsystem {
    name: string;
    quests: string[];  // Quest names within this subsystem
    hasRootFiles: boolean;  // True if subsystem folder directly has trail files (legacy)
}

interface TrailViewerState {
    rootFolder: string;
    currentFolder: string;
    folderOptions: TrailViewerFolderOption[];
    // New: separate tracking for two-dropdown UI
    subsystems: DiscoveredSubsystem[];
    selectedSubsystem: string;
    selectedQuest: string;
}

function hasRawTrailFiles(folder: string): boolean {
    if (!fs.existsSync(folder)) {
        return false;
    }
    let stat: fs.Stats;
    try {
        stat = fs.statSync(folder);
    } catch {
        return false;
    }
    if (!stat.isDirectory()) {
        return false;
    }
    const files = fs.readdirSync(folder);
    return files.some((name) => name.endsWith('.userprompt.md') || name.endsWith('.answer.md') || name.endsWith('.answer.json'));
}


function discoverRawTrailFolders(rootFolder: string): TrailViewerFolderOption[] {
    const options: TrailViewerFolderOption[] = [];

    // Check root folder itself for raw files (legacy)
    if (hasRawTrailFiles(rootFolder)) {
        options.push({
            id: path.basename(rootFolder) || 'trail',
            label: path.basename(rootFolder) || 'trail',
            folder: rootFolder,
        });
    }

    if (fs.existsSync(rootFolder)) {
        // Level 1: Discover subsystem folders (copilot, localllm, lm-api, etc.)
        const subsystemEntries = fs.readdirSync(rootFolder, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));

        for (const subsystemName of subsystemEntries) {
            const subsystemPath = path.join(rootFolder, subsystemName);

            // Check if subsystem folder directly has raw files (legacy flat structure)
            if (hasRawTrailFiles(subsystemPath)) {
                options.push({
                    id: subsystemName,
                    label: subsystemName,
                    folder: subsystemPath,
                });
            }

            // Level 2: Discover quest folders within subsystem (new structure: subsystem/quest/)
            const questEntries = fs.readdirSync(subsystemPath, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort((a, b) => a.localeCompare(b));

            for (const questName of questEntries) {
                const questPath = path.join(subsystemPath, questName);
                if (hasRawTrailFiles(questPath)) {
                    options.push({
                        id: `${subsystemName}/${questName}`,
                        label: `${subsystemName}/${questName}`,
                        folder: questPath,
                    });
                }
            }
        }
    }

    if (options.length === 0) {
        options.push({
            id: path.basename(rootFolder) || 'trail',
            label: path.basename(rootFolder) || 'trail',
            folder: rootFolder,
        });
    }

    return options;
}

/** Discover subsystems and their quest subfolders for the two-dropdown UI */
function discoverSubsystemsAndQuests(rootFolder: string): DiscoveredSubsystem[] {
    const subsystems: DiscoveredSubsystem[] = [];

    if (!fs.existsSync(rootFolder)) {
        return subsystems;
    }

    const subsystemEntries = fs.readdirSync(rootFolder, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));

    for (const subsystemName of subsystemEntries) {
        const subsystemPath = path.join(rootFolder, subsystemName);
        const hasRootFiles = hasRawTrailFiles(subsystemPath);

        // Discover quest subfolders
        const quests: string[] = [];
        try {
            const questEntries = fs.readdirSync(subsystemPath, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort((a, b) => a.localeCompare(b));

            for (const questName of questEntries) {
                const questPath = path.join(subsystemPath, questName);
                if (hasRawTrailFiles(questPath)) {
                    quests.push(questName);
                }
            }
        } catch {
            // Ignore read errors
        }

        // Only include subsystems that have quest folders or root files
        if (quests.length > 0 || hasRootFiles) {
            subsystems.push({
                name: subsystemName,
                quests,
                hasRootFiles,
            });
        }
    }

    return subsystems;
}

function buildViewerState(rootFolder: string, preferredQuest?: string): TrailViewerState {
    const folderOptions = discoverRawTrailFolders(rootFolder);
    const subsystems = discoverSubsystemsAndQuests(rootFolder);

    // Determine initial selection - prefer the current quest if available
    let selectedSubsystem = '';
    let selectedQuest = '';

    // Try to find a subsystem that contains the preferred quest
    if (preferredQuest && subsystems.length > 0) {
        const normalizedPreferred = preferredQuest.toLowerCase().replace(/-/g, '_');
        for (const sub of subsystems) {
            // Check for exact match first
            if (sub.quests.includes(preferredQuest)) {
                selectedSubsystem = sub.name;
                selectedQuest = preferredQuest;
                break;
            }
            // Check for case-insensitive / normalized match
            const matchingQuest = sub.quests.find(q => 
                q.toLowerCase().replace(/-/g, '_') === normalizedPreferred
            );
            if (matchingQuest) {
                selectedSubsystem = sub.name;
                selectedQuest = matchingQuest;
                break;
            }
        }
    }

    // Fallback to first subsystem/quest if preferred quest not found
    if (!selectedSubsystem && subsystems.length > 0) {
        selectedSubsystem = subsystems[0].name;
        if (subsystems[0].quests.length > 0) {
            selectedQuest = subsystems[0].quests[0];
        }
    }

    // Compute currentFolder based on selection
    let currentFolder = folderOptions[0]?.folder ?? rootFolder;
    if (selectedSubsystem && selectedQuest) {
        currentFolder = path.join(rootFolder, selectedSubsystem, selectedQuest);
    } else if (selectedSubsystem) {
        currentFolder = path.join(rootFolder, selectedSubsystem);
    }

    return {
        rootFolder,
        currentFolder,
        folderOptions,
        subsystems,
        selectedSubsystem,
        selectedQuest,
    };
}

function isSummaryTrailFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.prompts.md') || lower.endsWith('.answers.md');
}

function resolveTrailPathTokens(inputPath: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const aiFolder = vscode.workspace.getConfiguration('tomAi').get<string>('aiFolder') || '_ai';
    const replaced = inputPath
        .replace(/\$\{workspaceFolder\}/g, workspaceRoot)
        .replace(/\$\{ai\}/g, path.join(workspaceRoot, aiFolder))
        .replace(/\$\{home\}/g, os.homedir())
        .replace(/\$\{username\}/g, process.env.USER ?? process.env.USERNAME ?? 'user')
        // Strip ${quest} and ${subsystem} tokens - trail viewer discovers these dynamically
        .replace(/\/?\$\{quest\}/g, '')
        .replace(/\/?\$\{subsystem\}/g, '');

    if (path.isAbsolute(replaced)) {
        return replaced;
    }
    return path.join(workspaceRoot, replaced);
}

/** Get the trail ROOT folder (e.g., _ai/trail) for the viewer to discover subsystems/quests */
function getTrailRootFolder(): string {
    const trail = TomAiConfiguration.instance.getTrail() as Record<string, unknown>;
    const raw = (trail.raw ?? {}) as Record<string, unknown>;
    const paths = (raw.paths ?? {}) as Record<string, unknown>;
    
    // Get any configured path and extract the trail root (strip subsystem/quest parts)
    const configured = paths.copilot ?? paths.localLlm ?? paths.lmApi;
    if (typeof configured === 'string' && configured.trim().length > 0) {
        // The configured path is like ${ai}/trail/copilot/${quest}
        // We want ${ai}/trail
        const resolved = resolveTrailPathTokens(configured);
        // Walk up from the resolved path to find the trail root (parent of subsystem folders)
        // The resolved path would be like /workspace/_ai/trail/copilot
        const parts = resolved.split(path.sep);
        // Find 'trail' in the path and return up to there
        const trailIndex = parts.lastIndexOf('trail');
        if (trailIndex !== -1) {
            return parts.slice(0, trailIndex + 1).join(path.sep);
        }
        // Fallback: go up one level (assumes path is trail/subsystem)
        return path.dirname(resolved);
    }
    
    // Default fallback
    return WsPaths.ai('trail') ?? path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', '_ai', 'trail');
}

function getConfiguredCopilotRawTrailFolder(): string | undefined {
    // Return the trail root folder for the viewer
    return getTrailRootFolder();
}

function resolveRawTrailFolder(inputPath?: string): string | undefined {
    if (!inputPath) {
        return getConfiguredCopilotRawTrailFolder();
    }

    if (!fs.existsSync(inputPath)) {
        return inputPath;
    }

    const stat = fs.statSync(inputPath);
    return stat.isDirectory() ? inputPath : path.dirname(inputPath);
}

/**
 * Open or focus the Trail Viewer panel.
 */
export async function openTrailViewer(
    context: vscode.ExtensionContext,
    trailFolderOrFile?: string
): Promise<void> {
    const folder = resolveRawTrailFolder(trailFolderOrFile);
    
    if (!folder || !fs.existsSync(folder)) {
        vscode.window.showWarningMessage(`Trail folder not found: ${folder || '_ai/trail'}`);
        return;
    }
    
    // Get the current quest from the workspace file name
    const currentQuest = WsPaths.getWorkspaceQuestId();
    console.log('[TrailViewer] Current quest from workspace file:', currentQuest);
    
    const nextState = buildViewerState(folder, currentQuest !== 'default' ? currentQuest : undefined);
    console.log('[TrailViewer] Selected subsystem:', nextState.selectedSubsystem, 'quest:', nextState.selectedQuest);

    // If panel exists, just reveal it
    if (currentPanel) {
        currentViewerState = nextState;
        currentPanel.reveal(vscode.ViewColumn.One);
        currentPanel.webview.postMessage({
            type: 'refresh',
            folder: nextState.currentFolder,
            folderOptions: nextState.folderOptions,
            subsystems: nextState.subsystems,
            selectedSubsystem: nextState.selectedSubsystem,
            selectedQuest: nextState.selectedQuest,
        });
        attachTrailFolderWatcher(nextState.currentFolder);
        return;
    }

    currentViewerState = nextState;
    
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
    
    currentPanel.webview.html = getWebviewHtml(
        currentPanel.webview,
        context.extensionUri,
        currentViewerState,
    );
    
    // Handle messages from webview
    currentPanel.webview.onDidReceiveMessage(
        message => handleMessage(message, currentPanel!.webview, currentViewerState!, context),
        undefined,
        context.subscriptions
    );
    
    // Clean up on dispose
    currentPanel.onDidDispose(
        () => {
            currentPanel = undefined;
            currentViewerState = undefined;
            detachTrailFolderWatcher();
        },
        undefined,
        context.subscriptions
    );

    attachTrailFolderWatcher(currentViewerState.currentFolder);
}

/**
 * Watch the currently-displayed raw trail folder and push an `exchanges`
 * refresh into the webview whenever its contents change (file added /
 * renamed / removed). Debounced at 250 ms so a burst of writes — the
 * request file then its matching answer — only triggers one reload.
 */
function attachTrailFolderWatcher(folder: string): void {
    if (!folder || folder === currentWatchedFolder) {
        return;
    }
    detachTrailFolderWatcher();
    if (!fs.existsSync(folder)) {
        return;
    }
    try {
        currentWatcher = fs.watch(folder, { persistent: false, recursive: false }, () => {
            if (!currentPanel || !currentViewerState) { return; }
            if (pendingRefreshTimer) { clearTimeout(pendingRefreshTimer); }
            pendingRefreshTimer = setTimeout(() => {
                pendingRefreshTimer = undefined;
                if (!currentPanel || !currentViewerState) { return; }
                const exchanges = loadTrailExchanges(currentViewerState.currentFolder);
                currentPanel.webview.postMessage({ type: 'exchanges', exchanges });
            }, 250);
        });
        currentWatchedFolder = folder;
    } catch {
        // Ignore — watch is best-effort; users can reopen the panel to
        // force a full refresh if the platform can't watch the path.
    }
}

function detachTrailFolderWatcher(): void {
    if (pendingRefreshTimer) {
        clearTimeout(pendingRefreshTimer);
        pendingRefreshTimer = undefined;
    }
    if (currentWatcher) {
        try { currentWatcher.close(); } catch { /* ignore */ }
        currentWatcher = undefined;
    }
    currentWatchedFolder = undefined;
}

/**
 * Handle messages from the webview.
 */
async function handleMessage(
    message: any,
    webview: vscode.Webview,
    state: TrailViewerState,
    context: vscode.ExtensionContext,
): Promise<void> {
    switch (message.type) {
        case 'loadExchanges':
            const exchanges = loadTrailExchanges(state.currentFolder);
            webview.postMessage({ type: 'exchanges', exchanges });
            break;

        case 'switchSubsystem': {
            const selectedFolder = String(message.folder || '');
            const target = state.folderOptions.find((opt) => opt.folder === selectedFolder);
            if (target && fs.existsSync(target.folder)) {
                state.currentFolder = target.folder;
                const folderExchanges = loadTrailExchanges(state.currentFolder);
                webview.postMessage({
                    type: 'exchanges',
                    exchanges: folderExchanges,
                    selectedFolder: state.currentFolder,
                });
                attachTrailFolderWatcher(state.currentFolder);
            }
            break;
        }
            
        case 'loadExchange':
            const exchange = loadTrailExchanges(state.currentFolder).find(s => s.id === message.exchangeId);
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
            await extractToMarkdown(message.exchangeId, message.content, state.currentFolder);
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
        await vscode.commands.executeCommand('vscode.openWith', uri, 'tomAi.todoEditor');
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
    state: TrailViewerState
): string {
    const codiconsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
    );
    const folderOptionsJson = JSON.stringify(state.folderOptions);
    const selectedFolderJson = JSON.stringify(state.currentFolder);
    const subsystemsJson = JSON.stringify(state.subsystems);
    const selectedSubsystemJson = JSON.stringify(state.selectedSubsystem);
    const selectedQuestJson = JSON.stringify(state.selectedQuest);
    const rootFolderJson = JSON.stringify(state.rootFolder);
    
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
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .sidebar-header-title {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .sidebar-header-title h2 {
            font-size: 14px;
            font-weight: 600;
            flex: 1;
            margin: 0;
        }
        .sidebar-header-controls {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .sidebar-header select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 2px 4px;
            font-size: 11px;
            flex: 1;
            min-width: 0;
            cursor: pointer;
        }
        .sidebar-header select:focus {
            outline: 1px solid var(--vscode-focusBorder);
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
            <div class="sidebar-header-title">
                <h2>Exchanges</h2>
                <button id="refreshBtn" title="Refresh"><span class="codicon codicon-refresh"></span></button>
            </div>
            <div class="sidebar-header-controls">
                <select id="subsystemSelect" title="Subsystem"></select>
                <select id="questSelect" title="Quest"></select>
            </div>
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
            let folderOptions = ${folderOptionsJson};
            let selectedFolder = ${selectedFolderJson};
            let subsystems = ${subsystemsJson};
            let selectedSubsystem = ${selectedSubsystemJson};
            let selectedQuest = ${selectedQuestJson};
            const rootFolder = ${rootFolderJson};
            
            // Elements
            const exchangeList = document.getElementById('sessionList');
            const subsystemSelect = document.getElementById('subsystemSelect');
            const questSelect = document.getElementById('questSelect');
            const exchangeTitle = document.getElementById('exchangeTitle');
            const tabs = document.getElementById('tabs');
            const contentPane = document.getElementById('contentPane');
            const extractBtn = document.getElementById('extractBtn');
            const gotoTodoBtn = document.getElementById('gotoTodoBtn');
            const openInEditorBtn = document.getElementById('openInEditorBtn');
            const openExternallyBtn = document.getElementById('openExternallyBtn');
            const refreshBtn = document.getElementById('refreshBtn');

            function populateSubsystems() {
                subsystemSelect.innerHTML = '';
                for (const sub of subsystems) {
                    const element = document.createElement('option');
                    element.value = sub.name;
                    element.textContent = sub.name;
                    if (sub.name === selectedSubsystem) {
                        element.selected = true;
                    }
                    subsystemSelect.appendChild(element);
                }
                // Also populate quests for the selected subsystem
                populateQuests();
            }

            function populateQuests() {
                questSelect.innerHTML = '';
                const sub = subsystems.find(s => s.name === selectedSubsystem);
                if (!sub) {
                    questSelect.style.display = 'none';
                    return;
                }
                
                const quests = sub.quests || [];
                if (quests.length === 0) {
                    // No quest folders, hide the dropdown
                    questSelect.style.display = 'none';
                    // If subsystem has root files, use subsystem folder
                    if (sub.hasRootFiles) {
                        selectedQuest = '';
                        selectedFolder = rootFolder + '/' + selectedSubsystem;
                    }
                    return;
                }
                
                questSelect.style.display = '';
                for (const quest of quests) {
                    const element = document.createElement('option');
                    element.value = quest;
                    element.textContent = quest;
                    if (quest === selectedQuest) {
                        element.selected = true;
                    }
                    questSelect.appendChild(element);
                }
                
                // Ensure selectedQuest is valid
                if (!quests.includes(selectedQuest)) {
                    selectedQuest = quests[0] || '';
                    if (questSelect.options.length > 0) {
                        questSelect.options[0].selected = true;
                    }
                }
                
                // Update selectedFolder
                if (selectedQuest) {
                    selectedFolder = rootFolder + '/' + selectedSubsystem + '/' + selectedQuest;
                } else {
                    selectedFolder = rootFolder + '/' + selectedSubsystem;
                }
            }

            populateSubsystems();

            subsystemSelect.addEventListener('change', () => {
                selectedSubsystem = subsystemSelect.value;
                populateQuests();
                selectedExchange = null;
                exchangeContent = {};
                exchangeTodoRef = '';
                exchangeResponseValues = null;
                vscode.postMessage({ type: 'switchSubsystem', folder: selectedFolder });
            });

            questSelect.addEventListener('change', () => {
                selectedQuest = questSelect.value;
                if (selectedQuest) {
                    selectedFolder = rootFolder + '/' + selectedSubsystem + '/' + selectedQuest;
                } else {
                    selectedFolder = rootFolder + '/' + selectedSubsystem;
                }
                selectedExchange = null;
                exchangeContent = {};
                exchangeTodoRef = '';
                exchangeResponseValues = null;
                vscode.postMessage({ type: 'switchSubsystem', folder: selectedFolder });
            });
            
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
                openInEditorBtn.style.display = 'flex';
                openExternallyBtn.style.display = 'flex';
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
                        if (message.selectedFolder) {
                            selectedFolder = message.selectedFolder;
                            populateSubsystems();
                        }
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
                        if (Array.isArray(message.folderOptions)) {
                            folderOptions = message.folderOptions;
                        }
                        if (Array.isArray(message.subsystems)) {
                            subsystems = message.subsystems;
                        }
                        if (message.selectedSubsystem !== undefined) {
                            selectedSubsystem = message.selectedSubsystem;
                        }
                        if (message.selectedQuest !== undefined) {
                            selectedQuest = message.selectedQuest;
                        }
                        if (message.folder) {
                            selectedFolder = message.folder;
                        }
                        populateSubsystems();
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
        vscode.commands.registerCommand('tomAi.editor.rawTrailViewer', async (uri?: vscode.Uri) => 
            openTrailViewer(context, uri?.fsPath)
        ),
        vscode.commands.registerCommand('tomAi.editor.summaryTrailViewer', async (uri?: vscode.Uri) => {
            if (uri?.fsPath) {
                const invokedPath = uri.fsPath;
                if (fs.existsSync(invokedPath) && fs.statSync(invokedPath).isFile() && isSummaryTrailFile(invokedPath)) {
                    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(invokedPath), VIEW_TYPE);
                    return;
                }
                await openTrailViewer(context, invokedPath);
                return;
            }

            // Allow user to select either a summary trail file or a trail folder
            const selected = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: true,
                canSelectMany: false,
                title: 'Select Trail File or Folder',
                filters: {
                    'Trail files': ['md', 'json'],
                },
            });
            
            if (selected && selected[0]) {
                const selectedPath = selected[0].fsPath;
                if (fs.existsSync(selectedPath) && fs.statSync(selectedPath).isFile() && isSummaryTrailFile(selectedPath)) {
                    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(selectedPath), VIEW_TYPE);
                } else {
                    await openTrailViewer(context, selectedPath);
                }
            }
        }),
    ];
}
