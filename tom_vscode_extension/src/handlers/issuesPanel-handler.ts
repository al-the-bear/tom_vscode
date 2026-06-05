/**
 * Issues Panel Module
 *
 * Provides HTML, CSS, JS fragments and a message handler for issue management
 * panels.  Designed to be embedded inside the T3 panel as tabs.
 *
 * Two instances are created – one for ISSUES, one for TESTS – each scoped by a
 * prefix so their DOM element IDs do not collide.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    IssueProvider,
    IssueProviderRepo,
    getIssueProvider,
    registerIssueProvider,
} from './issueProvider';
import { GitHubIssueProvider } from './githubIssueProvider';
import { getConfigPath } from './handler_shared';
import { WsPaths } from '../utils/workspacePaths';
import { readMediaText } from '../utils/webviewLoader';

// ============================================================================
// Types & Configuration
// ============================================================================

export type PanelMode = 'issues' | 'tests';

interface ParsedStatus {
    name: string;
    color: string;
}

function parseStatusEntry(raw: string): ParsedStatus {
    const m = raw.match(/^(.+?)\[(.+?)\]$/);
    if (m) { return { name: m[1], color: m[2] }; }
    return { name: raw, color: 'grey' };
}

interface ColumnDef {
    key: string;
    style: string;
    minWidth: number;
    maxWidth: number;
    required: boolean;
}

function parseColumnDef(raw: string): ColumnDef | null {
    const m = raw.match(/^(\w+)(?:\{(\w+)\})?\[(\d+),(\d+)\](\*)?$/);
    if (!m) { return null; }
    return { key: m[1], style: m[2] || 'grey', minWidth: parseInt(m[3], 10), maxWidth: parseInt(m[4], 10), required: !!m[5] };
}

export interface IssuePanelConfig {
    provider: string;
    scanWorkspace: boolean;
    allReposOption: boolean;
    excludeRepos: string[];
    additionalRepos: string[];
    statuses: string[];
    statusColors: Record<string, string>;
    defaultColumns: string[];
    availableColumns: ColumnDef[];
    labels: string[];
    configError: string | null;
    columnLabels: Record<string, string>;
    growthPriority: string[];
}

function getPanelName(mode: PanelMode): string {
    return mode === 'issues' ? 'issueKit' : 'testkit';
}

const DEFAULT_COLUMN_LABELS: Record<string, string> = {
    statusDot: '', id: 'ID', title: 'Title', repository: 'Repository',
    repositoryOwner: 'Owner', status: 'Status', author: 'Author',
    commentCount: '# of Comments', creationTimestamp: 'Created', updateTimestamp: 'Updated',
    labels: 'Labels',
};

const DEFAULT_GROWTH_PRIORITY: string[] = ['title', 'author', 'repository', 'status', 'repositoryOwner'];

const DEFAULT_AVAILABLE_COLUMNS: ColumnDef[] = [
    { key: 'statusDot', style: 'dot', minWidth: 20, maxWidth: 20, required: true },
    { key: 'id', style: 'grey', minWidth: 32, maxWidth: 32, required: true },
    { key: 'title', style: 'normal', minWidth: 150, maxWidth: 400, required: true },
    { key: 'repository', style: 'grey', minWidth: 80, maxWidth: 150, required: false },
    { key: 'repositoryOwner', style: 'grey', minWidth: 80, maxWidth: 150, required: false },
    { key: 'status', style: 'grey', minWidth: 60, maxWidth: 120, required: false },
    { key: 'author', style: 'grey', minWidth: 60, maxWidth: 150, required: false },
    { key: 'commentCount', style: 'grey', minWidth: 20, maxWidth: 20, required: false },
    { key: 'creationTimestamp', style: 'grey', minWidth: 80, maxWidth: 80, required: false },
    { key: 'updateTimestamp', style: 'grey', minWidth: 80, maxWidth: 80, required: false },
];

export function loadPanelConfig(mode: PanelMode): IssuePanelConfig {
    const panelName = getPanelName(mode);
    const defaultStatuses = ['open[green]', 'in_triage[yellow]', 'assigned[red]', 'closed[grey]'];
    const defaults: IssuePanelConfig = {
        provider: 'github',
        scanWorkspace: mode === 'issues',
        allReposOption: mode === 'issues',
        excludeRepos: [],
        additionalRepos: [],
        statuses: defaultStatuses.map(s => parseStatusEntry(s).name),
        statusColors: Object.fromEntries(defaultStatuses.map(s => { const p = parseStatusEntry(s); return [p.name, p.color]; })),
        defaultColumns: ['author', 'commentCount', 'creationTimestamp', 'updateTimestamp'],
        availableColumns: [...DEFAULT_AVAILABLE_COLUMNS],
        labels: ['quicklabel=Flaky', 'quicklabel=Regression', 'quicklabel=Blocked'],
        configError: null,
        columnLabels: { ...DEFAULT_COLUMN_LABELS },
        growthPriority: [...DEFAULT_GROWTH_PRIORITY],
    };
    try {
        const configPath = getConfigPath();
        if (!configPath || !fs.existsSync(configPath)) { return defaults; }
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const panels = raw['issuePanels'];
        if (!panels || typeof panels !== 'object') { return defaults; }
        const cfg = panels[panelName];
        if (!cfg) { return defaults; }

        // Parse common section
        const common = panels['common'];
        let columnLabels = { ...DEFAULT_COLUMN_LABELS };
        let growthPriority = [...DEFAULT_GROWTH_PRIORITY];
        if (common && typeof common === 'object') {
            if (common.columnLabels && typeof common.columnLabels === 'object') {
                columnLabels = { ...columnLabels, ...common.columnLabels };
            }
            if (Array.isArray(common.growthPriority) && common.growthPriority.length > 0) {
                growthPriority = common.growthPriority;
            }
        }

        // Parse statuses
        const rawStatuses: string[] = Array.isArray(cfg.statuses) && cfg.statuses.length > 0 ? cfg.statuses : defaultStatuses;
        const statuses = rawStatuses.map((s: string) => parseStatusEntry(s).name);
        const statusColors: Record<string, string> = {};
        for (const s of rawStatuses) { const p = parseStatusEntry(s); statusColors[p.name] = p.color; }

        // Parse availableColumns
        let availableColumns: ColumnDef[] = [...DEFAULT_AVAILABLE_COLUMNS];
        let configError: string | null = null;
        if (Array.isArray(cfg.availableColumns) && cfg.availableColumns.length > 0) {
            const parsed: ColumnDef[] = [];
            for (let i = 0; i < cfg.availableColumns.length; i++) {
                const col = parseColumnDef(cfg.availableColumns[i]);
                if (!col) {
                    configError = `Invalid column definition at index ${i}: "${cfg.availableColumns[i]}". ` +
                        `Expected format: "columnName{style}[minWidth,maxWidth]" or "columnName{style}[minWidth,maxWidth]*" for required columns. ` +
                        `Section: issuePanels.${panelName}.availableColumns`;
                    break;
                }
                parsed.push(col);
            }
            if (!configError) { availableColumns = parsed; }
        }

        // Parse defaultColumns
        let defaultCols: string[] = defaults.defaultColumns;
        if (typeof cfg.defaultColumns === 'string' && cfg.defaultColumns.trim().length > 0) {
            defaultCols = cfg.defaultColumns.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
            // Validate that each default column exists in available and is not required
            const availableKeys = new Set(availableColumns.map(c => c.key));
            for (const dc of defaultCols) {
                if (!availableKeys.has(dc)) {
                    configError = `defaultColumns references unknown column "${dc}". ` +
                        `Available columns: ${availableColumns.map(c => c.key).join(', ')}. ` +
                        `Section: issuePanels.${panelName}.defaultColumns`;
                    break;
                }
            }
        }

        return {
            provider: typeof cfg.provider === 'string' ? cfg.provider : defaults.provider,
            scanWorkspace: typeof cfg.scanWorkspace === 'boolean' ? cfg.scanWorkspace : defaults.scanWorkspace,
            allReposOption: typeof cfg.allReposOption === 'boolean' ? cfg.allReposOption : defaults.allReposOption,
            excludeRepos: Array.isArray(cfg.excludeRepos) ? cfg.excludeRepos : [],
            additionalRepos: Array.isArray(cfg.additionalRepos) ? cfg.additionalRepos : [],
            statuses,
            statusColors,
            defaultColumns: defaultCols,
            availableColumns,
            labels: Array.isArray(cfg.labels) ? cfg.labels : defaults.labels,
            configError,
            columnLabels,
            growthPriority,
        };
    } catch (e: any) {
        return { ...defaults, configError: `Failed to parse config: ${e.message}` };
    }
}

// ============================================================================
// Provider initialisation
// ============================================================================

export function initIssueProviders(): void {
    registerIssueProvider(new GitHubIssueProvider());
}

// ============================================================================
// HTML fragment  (prefix is "issues" or "tests")
// ============================================================================

export function getIssuesHtmlFragment(prefix: string): string {
    // Body lives in media/issuesPanel/fragment.html with a {{prefix}} token
    // (the panel is instantiated twice, "issues" and "tests", scoping all
    // element IDs). readMediaText does no rewriting, so we substitute here.
    return readMediaText('issuesPanel', 'fragment.html').replace(/\{\{prefix\}\}/g, prefix);
}

// ============================================================================
// CSS  (component-level – no body / global reset)
// ============================================================================

export function getIssuesCss(): string {
    // Body lives in media/issuesPanel/style.css (verbatim, no rewriting).
    return readMediaText('issuesPanel', 'style.css');
}

// ============================================================================
// Script  (prefix-scoped IIFE – uses global `vscode` from T3 panel)
// ============================================================================

export function getIssuesScript(prefix: string, mode: PanelMode): string {
    // The IIFE body lives in media/issuesPanel/main.js (verbatim). The two
    // instance-scoped values (prefix + mode) are prepended as globals that the
    // static script reads. Two instances ("issues"/"tests") are concatenated
    // into one <script> by the host; because each IIFE runs synchronously
    // before the next prepend reassigns these vars, the values stay correct.
    return `var _issuesPrefix = ${JSON.stringify(prefix)};\n`
        + `var _issuesMode = ${JSON.stringify(mode)};\n`
        + readMediaText('issuesPanel', 'main.js');
}

// ============================================================================
// Extension-side message handler
// ============================================================================

export async function handleIssuesPanelMessage(msg: any, webview: vscode.Webview): Promise<void> {
    const mode: PanelMode = msg.panelMode;
    if (!mode) { return; }

    const config = loadPanelConfig(mode);

    function getProvider(): IssueProvider {
        const provider = getIssueProvider(config.provider);
        if (!provider) { throw new Error(`Issue provider "${config.provider}" is not registered`); }
        return provider;
    }

    switch (msg.type) {
        case 'issuesReady': {
            const configFilePath = getConfigPath() || '';
            const panelName = getPanelName(mode);
            // If config has errors, send them to client
            if (config.configError) {
                webview.postMessage({
                    type: 'issuesInit', repos: [], statuses: config.statuses, statusColors: config.statusColors,
                    labels: config.labels, panelMode: mode,
                    columnDefs: config.availableColumns, defaultColumns: config.defaultColumns,
                    allReposOption: config.allReposOption,
                    columnLabels: config.columnLabels, growthPriority: config.growthPriority,
                    configError: config.configError, configSection: `issuePanels.${panelName}`, configFilePath,
                });
                break;
            }
            const provider = getProvider();
            let repos: IssueProviderRepo[];
            const excludeSet = new Set(config.excludeRepos);
            // Parse additionalRepos: "Prefix:owner/repo" or just "owner/repo"
            const additional: IssueProviderRepo[] = config.additionalRepos.map(r => {
                const colonIdx = r.indexOf(':');
                if (colonIdx > 0) {
                    const prefix = r.substring(0, colonIdx);
                    const repoId = r.substring(colonIdx + 1);
                    return { id: repoId, displayName: `${prefix}: ${repoId}` };
                }
                return { id: r, displayName: r };
            });
            const additionalIds = new Set(additional.map(a => a.id));
            if (config.scanWorkspace) {
                const wsRepos = provider.discoverRepos();
                wsRepos.sort((a, b) => a.displayName.localeCompare(b.displayName));
                const filtered = wsRepos.filter(r => !additionalIds.has(r.id) && !excludeSet.has(r.id));
                repos = [...additional, ...filtered];
            } else {
                repos = [...additional];
            }
            webview.postMessage({
                type: 'issuesInit', repos, statuses: config.statuses, statusColors: config.statusColors,
                labels: config.labels, panelMode: mode,
                columnDefs: config.availableColumns, defaultColumns: config.defaultColumns,
                allReposOption: config.allReposOption,
                columnLabels: config.columnLabels, growthPriority: config.growthPriority,
                configError: null, configSection: `issuePanels.${panelName}`, configFilePath,
            });
            break;
        }

        case 'loadIssues': {
            try {
                const provider = getProvider();
                const issues = await provider.listIssues(msg.repoId, msg.state || 'all');
                webview.postMessage({ type: 'issues', issues, repoId: msg.repoId, panelMode: mode });
            } catch (e: any) {
                webview.postMessage({ type: 'issuesError', message: e.message, panelMode: mode });
            }
            break;
        }

        case 'loadComments': {
            try {
                const provider = getProvider();
                const comments = await provider.listComments(msg.repoId, msg.issueNumber);
                webview.postMessage({ type: 'comments', comments, issueNumber: msg.issueNumber, panelMode: mode });
            } catch (e: any) {
                webview.postMessage({ type: 'issuesError', message: e.message, panelMode: mode });
            }
            break;
        }

        case 'createIssue': {
            try {
                const provider = getProvider();
                const issue = await provider.createIssue(msg.repoId, msg.title, msg.body || '');
                webview.postMessage({ type: 'issueCreated', issue, panelMode: mode });
                vscode.window.showInformationMessage(`Issue #${issue.number} created`);
            } catch (e: any) {
                webview.postMessage({ type: 'issuesError', message: e.message, panelMode: mode });
            }
            break;
        }

        case 'addComment': {
            try {
                const provider = getProvider();
                const comment = await provider.addComment(msg.repoId, msg.issueNumber, msg.body);
                webview.postMessage({ type: 'commentAdded', comment, issueNumber: msg.issueNumber, panelMode: mode });
            } catch (e: any) {
                webview.postMessage({ type: 'issuesError', message: e.message, panelMode: mode });
            }
            break;
        }

        case 'changeStatus': {
            try {
                const provider = getProvider();
                const issue = await provider.changeStatus(msg.repoId, msg.issueNumber, msg.status, config.statuses);
                webview.postMessage({ type: 'issueUpdated', issue, panelMode: mode });
                vscode.window.showInformationMessage(`Issue #${msg.issueNumber} → ${msg.status}`);
            } catch (e: any) {
                webview.postMessage({ type: 'issuesError', message: e.message, panelMode: mode });
            }
            break;
        }

        case 'toggleLabel': {
            try {
                const provider = getProvider();
                const issue = await provider.toggleLabel(msg.repoId, msg.issueNumber, msg.label);
                const eqIdx = msg.label.indexOf('=');
                const displayLabel = eqIdx > 0 ? msg.label.substring(eqIdx + 1) : msg.label;
                webview.postMessage({ type: 'issueUpdated', issue, panelMode: mode });
                vscode.window.showInformationMessage(`Issue #${msg.issueNumber}: toggled label "${displayLabel}"`);
            } catch (e: any) {
                webview.postMessage({ type: 'issuesError', message: e.message, panelMode: mode });
            }
            break;
        }

        case 'openExternal': {
            if (msg.url) { vscode.env.openExternal(vscode.Uri.parse(msg.url)); }
            break;
        }

        case 'openConfigFile': {
            const filePath = getConfigPath();
            if (filePath) {
                const uri = vscode.Uri.file(filePath);
                vscode.window.showTextDocument(uri);
            }
            break;
        }

        case 'pickAttachment': {
            const files = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach' });
            if (files && files.length > 0) {
                const attachments = files.map(f => ({ name: path.basename(f.fsPath), path: f.fsPath }));
                webview.postMessage({ type: 'attachmentsPicked', attachments, panelMode: mode });
            }
            break;
        }

        case 'uploadAttachment': {
            try {
                const provider = getProvider();
                if (!provider.supportsAttachments || !provider.uploadAttachment) {
                    // Local fallback: store in quest attachments folder
                    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (wsRoot && msg.filePath && msg.fileName) {
                        const attachDir = WsPaths.ai('attachments', `issue-${msg.issueNumber}`) || path.join(wsRoot, '_ai', 'attachments', `issue-${msg.issueNumber}`);
                        fs.mkdirSync(attachDir, { recursive: true });
                        const destPath = path.join(attachDir, msg.fileName);
                        fs.copyFileSync(msg.filePath, destPath);
                        const stat = fs.statSync(destPath);
                        webview.postMessage({
                            type: 'attachmentUploaded',
                            attachment: { id: msg.fileName, name: msg.fileName, size: stat.size, url: destPath },
                            panelMode: mode,
                        });
                    }
                    break;
                }
                const attachment = await provider.uploadAttachment(msg.repoId, msg.issueNumber, msg.filePath, msg.fileName);
                webview.postMessage({ type: 'attachmentUploaded', attachment, panelMode: mode });
            } catch (e: any) {
                webview.postMessage({ type: 'issuesError', message: `Upload failed: ${e.message}`, panelMode: mode });
            }
            break;
        }

        case 'listAttachments': {
            try {
                const provider = getProvider();
                let attachments: Array<{ id: string; name: string; size: number; url: string }> = [];
                if (provider.supportsAttachments && provider.listAttachments) {
                    attachments = await provider.listAttachments(msg.repoId, msg.issueNumber);
                } else {
                    // Local fallback: list files from local attachment directory
                    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (wsRoot) {
                        const attachDir = WsPaths.ai('attachments', `issue-${msg.issueNumber}`) || path.join(wsRoot, '_ai', 'attachments', `issue-${msg.issueNumber}`);
                        if (fs.existsSync(attachDir)) {
                            const files = fs.readdirSync(attachDir);
                            attachments = files.map(f => {
                                const stat = fs.statSync(path.join(attachDir, f));
                                return { id: f, name: f, size: stat.size, url: path.join(attachDir, f) };
                            });
                        }
                    }
                }
                webview.postMessage({ type: 'attachmentsList', attachments, issueNumber: msg.issueNumber, panelMode: mode });
            } catch (e: any) {
                webview.postMessage({ type: 'issuesError', message: `List attachments failed: ${e.message}`, panelMode: mode });
            }
            break;
        }

        case 'deleteAttachment': {
            try {
                const provider = getProvider();
                if (provider.supportsAttachments && provider.deleteAttachment) {
                    await provider.deleteAttachment(msg.repoId, msg.issueNumber, msg.attachmentId);
                } else {
                    // Local fallback: delete from local attachment directory
                    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (wsRoot) {
                        const filePath = WsPaths.ai('attachments', `issue-${msg.issueNumber}`, msg.attachmentId) || path.join(wsRoot, '_ai', 'attachments', `issue-${msg.issueNumber}`, msg.attachmentId);
                        if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
                    }
                }
                webview.postMessage({ type: 'attachmentDeleted', attachmentId: msg.attachmentId, panelMode: mode });
            } catch (e: any) {
                webview.postMessage({ type: 'issuesError', message: `Delete attachment failed: ${e.message}`, panelMode: mode });
            }
            break;
        }
    }
}
