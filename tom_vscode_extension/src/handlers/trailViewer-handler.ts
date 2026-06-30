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
import { loadWebviewHtml } from '../utils/webviewLoader';
import { WsPaths } from '../utils/workspacePaths';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';
import { resolveTrailPath } from '../services/trailPathResolver';
import { openInExternalApplication } from './handler_shared';
import { readWorkspaceTodos } from '../managers/questTodoManager.js';
import { selectTodoInBottomPanel } from './questTodoPanel-handler.js';
import { extractResponseValuesFromText, extractTodoRefFromText } from '../utils/responseValues.js';

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

// ============================================================================
// Webview Panel
// ============================================================================

// Custom-editor viewType (summary trail files) — used by the `vscode.openWith`
// calls below, which route to the TrailEditorProvider in trailEditor-handler.ts.
const VIEW_TYPE = 'tomAi.trailViewer';
// Distinct viewType for the *free* raw-trail webview panel created here. It must
// NOT reuse VIEW_TYPE: that string is already owned by the document-backed
// custom editor, and a WebviewPanelSerializer cannot share a viewType with a
// custom-editor provider. Matches the `tomAi.editor.rawTrailViewer` command.
const RAW_VIEW_TYPE = 'tomAi.rawTrailViewer';
// workspaceState key holding the last-viewed raw-trail folder so the panel can
// re-open the same trail after a window reload.
const RAW_TRAIL_STATE_KEY = 'tomAi.rawTrailViewer.lastFolder';

interface PersistedRawTrailState {
    rootFolder: string;
    currentFolder: string;
}

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

                // Level 3: sub-category folders within the quest directory
                // (e.g. anthropic/{quest}/compaction, anthropic/{quest}/memory)
                try {
                    const categoryEntries = fs.readdirSync(questPath, { withFileTypes: true })
                        .filter((entry) => entry.isDirectory())
                        .map((entry) => entry.name)
                        .sort((a, b) => a.localeCompare(b));

                    for (const catName of categoryEntries) {
                        const catPath = path.join(questPath, catName);
                        if (hasRawTrailFiles(catPath)) {
                            options.push({
                                id: `${subsystemName}/${questName}/${catName}`,
                                label: `${subsystemName}/${questName}/${catName}`,
                                folder: catPath,
                            });
                        }
                    }
                } catch {
                    // Ignore — non-critical discovery
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
                // Also surface sub-category folders as separate quest-like entries
                try {
                    const catEntries = fs.readdirSync(questPath, { withFileTypes: true })
                        .filter((e) => e.isDirectory())
                        .map((e) => e.name)
                        .sort();
                    for (const catName of catEntries) {
                        const catPath = path.join(questPath, catName);
                        if (hasRawTrailFiles(catPath)) {
                            quests.push(`${questName}/${catName}`);
                        }
                    }
                } catch { /* ignore */ }
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

function buildViewerState(
    rootFolder: string,
    preferredQuest?: string,
    preferredSubsystem?: string,
): TrailViewerState {
    const folderOptions = discoverRawTrailFolders(rootFolder);
    const subsystems = discoverSubsystemsAndQuests(rootFolder);

    // Determine initial selection - prefer the explicit subsystem hint
    // (from the originating panel), then the current quest, then the first.
    let selectedSubsystem = '';
    let selectedQuest = '';

    // 1. Caller-provided subsystem hint wins outright when the subsystem
    //    exists in the discovered set. Quest is chosen from that subsystem.
    if (preferredSubsystem) {
        const sub = subsystems.find((s) => s.name === preferredSubsystem);
        if (sub) {
            selectedSubsystem = sub.name;
            if (preferredQuest && sub.quests.includes(preferredQuest)) {
                selectedQuest = preferredQuest;
            } else if (sub.quests.length > 0) {
                selectedQuest = sub.quests[0];
            }
        }
    }

    // 2. No subsystem hint (or hint not found): fall back to quest-only
    //    matching across all subsystems in alphabetical order.
    if (!selectedSubsystem && preferredQuest && subsystems.length > 0) {
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

// Historical note: this module used to carry its own mini path resolver
// (workspaceFolder / ai / home / username plus a quest+subsystem strip
// pass). It has been replaced by the shared resolveTrailPath() helper
// in services/trailPathResolver.ts — which delegates to the canonical
// resolveVariables() plus the optional strip mode below. Search for
// `resolveTrailPath(..., { mode: 'strip' })` to find the call site.

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
        const resolved = resolveTrailPath(configured, {}, { mode: 'strip' });
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
 *
 * @param preferredSubsystem Optional hint (e.g. 'copilot', 'anthropic') so the
 *   caller can request a specific subsystem be pre-selected in the dropdown
 *   instead of the alphabetically-first discovered one. Used by the chat
 *   panel trail buttons so clicking from the copilot accordion pre-selects
 *   the copilot subsystem and clicking from anthropic pre-selects anthropic.
 */
export async function openTrailViewer(
    context: vscode.ExtensionContext,
    trailFolderOrFile?: string,
    preferredSubsystem?: string,
): Promise<void> {
    const folder = resolveRawTrailFolder(trailFolderOrFile);

    if (!folder || !fs.existsSync(folder)) {
        vscode.window.showWarningMessage(`Trail folder not found: ${folder || '_ai/trail'}`);
        return;
    }

    // Get the current quest from the workspace file name
    const currentQuest = WsPaths.getWorkspaceQuestId();
    console.log('[TrailViewer] Current quest from workspace file:', currentQuest);

    const nextState = buildViewerState(
        folder,
        currentQuest !== 'default' ? currentQuest : undefined,
        preferredSubsystem,
    );
    console.log('[TrailViewer] Selected subsystem:', nextState.selectedSubsystem, 'quest:', nextState.selectedQuest);

    void persistRawTrailState(context, nextState);

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

    // Create new panel and wire it up via the shared bind path.
    const panel = vscode.window.createWebviewPanel(
        RAW_VIEW_TYPE,
        'Prompt Trail Viewer',
        vscode.ViewColumn.One,
        {
            ...getTrailViewerWebviewOptions(context),
            retainContextWhenHidden: true,
        }
    );
    bindTrailViewerPanel(context, panel, nextState);
}

/** Webview options shared by the fresh-open and reload-restore paths. */
function getTrailViewerWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
    };
}

/**
 * Wire a (freshly-created or reload-restored) raw Trail Viewer panel: adopt it
 * as the singleton, paint the HTML for `state`, install the message handler,
 * attach the folder watcher, and clean up on dispose. Both `openTrailViewer`
 * and the reload serializer call this so the wiring lives in one place.
 */
function bindTrailViewerPanel(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    state: TrailViewerState,
): void {
    currentPanel = panel;
    currentViewerState = state;

    panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, state);

    panel.webview.onDidReceiveMessage(
        message => handleMessage(message, panel.webview, currentViewerState!, context),
        undefined,
        context.subscriptions
    );

    panel.onDidDispose(
        () => {
            currentPanel = undefined;
            currentViewerState = undefined;
            detachTrailFolderWatcher();
        },
        undefined,
        context.subscriptions
    );

    attachTrailFolderWatcher(state.currentFolder);
}

/**
 * Persist the currently-viewed raw-trail folder so the serializer can re-open
 * the same trail after a window reload. Only the root + current folder are
 * stored; subsystem/quest are re-derived from the path on restore.
 */
function persistRawTrailState(context: vscode.ExtensionContext, state: TrailViewerState): void {
    void context.workspaceState.update(RAW_TRAIL_STATE_KEY, {
        rootFolder: state.rootFolder,
        currentFolder: state.currentFolder,
    } satisfies PersistedRawTrailState);
}

/**
 * Rebuild a TrailViewerState from a persisted folder. Subsystem/quest are
 * derived from `currentFolder` relative to `rootFolder` so the dropdowns come
 * back on the same selection. Returns undefined if the root no longer exists.
 */
function restoreRawTrailState(persisted: PersistedRawTrailState): TrailViewerState | undefined {
    const { rootFolder, currentFolder } = persisted;
    if (!rootFolder || !fs.existsSync(rootFolder)) {
        return undefined;
    }
    let subsystem: string | undefined;
    let quest: string | undefined;
    if (currentFolder) {
        const rel = path.relative(rootFolder, currentFolder);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            const parts = rel.split(path.sep);
            subsystem = parts[0] || undefined;
            quest = parts.length > 1 ? parts.slice(1).join('/') : undefined;
        }
    }
    const state = buildViewerState(rootFolder, quest, subsystem);
    if (currentFolder && fs.existsSync(currentFolder)) {
        state.currentFolder = currentFolder;
    }
    return state;
}

/**
 * Register the serializer that restores the raw Trail Viewer panel after a
 * window reload. Keyed on RAW_VIEW_TYPE (distinct from the custom editor's
 * `tomAi.trailViewer`). Rebuilds from the persisted folder; if nothing is
 * persisted or the folder is gone, the recreated tab is disposed rather than
 * restored to a broken/empty viewer.
 */
function registerRawTrailViewerSerializer(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(RAW_VIEW_TYPE, {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
            if (currentPanel) { panel.dispose(); return; }
            const persisted = context.workspaceState.get<PersistedRawTrailState>(RAW_TRAIL_STATE_KEY);
            const state = persisted ? restoreRawTrailState(persisted) : undefined;
            if (!state) { panel.dispose(); return; }
            panel.webview.options = getTrailViewerWebviewOptions(context);
            bindTrailViewerPanel(context, panel, state);
        },
    });
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
                persistRawTrailState(context, state);
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
    // Initial state previously interpolated into the inline script now flows
    // through the loader's window.__INIT__ payload (see media/trailViewer/main.js).
    return loadWebviewHtml(webview, 'trailViewer', {
        init: {
            codiconsUri: codiconsUri.toString(),
            folderOptions: state.folderOptions,
            currentFolder: state.currentFolder,
            subsystems: state.subsystems,
            selectedSubsystem: state.selectedSubsystem,
            selectedQuest: state.selectedQuest,
            rootFolder: state.rootFolder,
        },
    });
}

// ============================================================================
// Command Registration
// ============================================================================

export function registerTrailViewerCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
    return [
        // Restore the raw-trail webview panel after a window reload. Registered
        // here so it activates with the rest of the trail-viewer surface.
        registerRawTrailViewerSerializer(context),
        // `rawTrailViewer` = the grouped-exchanges overview of the raw
        // trail files in _ai/trail/{subsystem}/{quest}/ (individual
        // .userprompt.md + .answer.json files). Opens a webview panel
        // with subsystem + quest dropdowns. Second arg is a subsystem
        // hint so callers can request a specific subsystem be pre-selected.
        vscode.commands.registerCommand(
            'tomAi.editor.rawTrailViewer',
            async (uri?: vscode.Uri, preferredSubsystem?: string) =>
                openTrailViewer(context, uri?.fsPath, preferredSubsystem),
        ),
        // `summaryTrailViewer` = the per-file summary viewer for the
        // concatenated .prompts.md / .answers.md files in _ai/quests/.
        // Opens the custom editor (TrailEditorProvider) for a specific
        // summary file; falls back to the webview panel when given a
        // directory; picker with no argument.
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

            const selected = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: true,
                canSelectMany: false,
                title: 'Select Trail File or Folder',
                filters: { 'Trail files': ['md', 'json'] },
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
