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

interface IssuePanelConfig {
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

function loadPanelConfig(mode: PanelMode): IssuePanelConfig {
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
    return `
<div class="issues-root" id="${prefix}-root">
  <div class="issues-browser" id="${prefix}-browser">
    <div class="browser-toolbar">
      <select id="${prefix}-repoSelect"><option value="">Loading…</option></select>
      <button id="${prefix}-filterBtn" class="icon-btn" title="Filter by status"><span class="codicon codicon-filter"></span></button>
      <button id="${prefix}-sortBtn" class="icon-btn" title="Sort issues"><span class="codicon codicon-list-ordered"></span></button>
      <button id="${prefix}-refreshBtn" class="icon-btn" title="Refresh"><span class="codicon codicon-refresh"></span></button>
    </div>
    <div id="${prefix}-issueList" class="issue-list"></div>
    <div id="${prefix}-filterPicker" class="picker-overlay" style="display:none;"></div>
    <div id="${prefix}-sortPicker" class="picker-overlay sort-picker-overlay" style="display:none;"></div>
    <div id="${prefix}-columnPicker" class="picker-overlay column-picker-overlay" style="display:none;"></div>
  </div>
  <div id="${prefix}-splitHandle" class="split-handle"></div>
  <div class="issues-editor" id="${prefix}-editor">
    <div class="editor-toolbar">
      <span id="${prefix}-issueTitle" class="issue-title-bar">No issue selected</span>
      <div class="toolbar-icons">
        <select id="${prefix}-statusSelect" class="status-select" style="display:none;" title="Change status"></select>
        <button id="${prefix}-openBrowserBtn" class="icon-btn" title="Open in Browser" style="display:none;"><span class="codicon codicon-link-external"></span></button>
        <button id="${prefix}-labelsBtn" class="icon-btn" title="Quick Labels" style="display:none;"><span class="codicon codicon-tag"></span></button>
        <button id="${prefix}-addBtn" class="icon-btn" title="New Issue"><span class="codicon codicon-add"></span></button>
      </div>
    </div>
    <div id="${prefix}-commentHistory" class="comment-history"></div>
    <div id="${prefix}-vSplitHandle" class="v-split-handle"></div>
    <div id="${prefix}-attachmentArea" class="attachment-area" style="display:none;">
      <div id="${prefix}-attachmentList" class="attachment-list"></div>
    </div>
    <div id="${prefix}-inputArea" class="input-area">
      <div class="input-column">
        <input id="${prefix}-titleInput" type="text" placeholder="Issue title…" style="display:none;" />
        <textarea id="${prefix}-inputText" placeholder="Write a comment…"></textarea>
      </div>
      <div class="input-icons">
        <button id="${prefix}-attachBtn" class="icon-btn" title="Add Attachment"><span class="codicon codicon-attach"></span></button>
        <button id="${prefix}-sendBtn" class="icon-btn send-btn" title="Send"><span class="codicon codicon-send"></span></button>
      </div>
    </div>
    <div id="${prefix}-labelsPicker" class="labels-picker" style="display:none;"></div>
  </div>
</div>`;
}

// ============================================================================
// CSS  (component-level – no body / global reset)
// ============================================================================

export function getIssuesCss(): string {
    return `
/* ---- Issues panel layout ---- */
.issues-root {
    display: flex;
    flex-direction: row;
    height: 100%;
    width: 100%;
}
.issues-browser {
    flex: 0 0 280px;
    min-width: 160px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--vscode-panel-border);
    overflow: hidden;
    position: relative;
}
.browser-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBarSectionHeader-background);
}
.browser-toolbar select {
    padding: 2px 4px;
    height: 22px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 3px;
    font-size: 12px;
}
.browser-toolbar select:first-child { flex: 1; min-width: 80px; }
.issues-root .icon-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; }
.issues-root .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.issues-root .icon-btn.send-btn { color: var(--vscode-textLink-foreground); }
.issues-root .icon-btn.send-btn:hover { color: var(--vscode-textLink-activeForeground); }
.issue-list {
    flex: 1;
    overflow-y: auto;
    position: relative;
}
/* Table rows */
.issue-row {
    display: flex;
    align-items: center;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 12px;
    line-height: 1.4;
    overflow: hidden;
}
.issue-row:hover { background: var(--vscode-list-hoverBackground); }
.issue-row.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
}
/* Table cells */
.issue-cell {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 3px 4px;
    box-sizing: border-box;
    flex-shrink: 0;
    flex-grow: 0;
    font-size: 11px;
    border-right: 1px solid var(--vscode-panel-border);
}
.issue-cell:last-child { border-right: none; }
.issue-cell.cell-style-dot {
    display: flex;
    align-items: center;
    justify-content: center;
}
.issue-cell.cell-style-normal { color: var(--vscode-foreground); font-size: 12px; }
.issue-cell.cell-style-grey { color: var(--vscode-descriptionForeground); font-size: 11px; }
.issue-state-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
/* Column resize handles */
.col-resize-handles { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 10; }
.col-resize-handle { position: absolute; top: 0; bottom: 0; width: 5px; cursor: col-resize; pointer-events: auto; background: transparent; }
.col-resize-handle:hover, .col-resize-handle.dragging { background: var(--vscode-editorWidget-border, #555); }
/* Config error */
.config-error { padding: 16px; font-size: 12px; color: var(--vscode-errorForeground); }
.config-error h3 { margin: 0 0 8px 0; font-size: 13px; }
.config-error code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 11px; }
.config-error a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
.icon-btn.active-indicator { background: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; border-radius: 3px; }
.icon-btn.active-indicator:hover { background: var(--vscode-button-hoverBackground); }
.column-picker-overlay { position: fixed; left: 0; top: 0; }

/* ---- Picker overlays ---- */
.picker-overlay {
    position: absolute; left: 6px; top: 32px;
    background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border);
    border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    z-index: 100; padding: 4px 0; min-width: 180px; max-height: 300px; overflow-y: auto;
}
.picker-option { padding: 4px 10px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 6px; }
.picker-option:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
.picker-option.dimmed { opacity: 0.5; }
.picker-option .check-box { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.picker-option .check-box .codicon { font-size: 14px; }
.picker-section-header { padding: 6px 10px 3px 10px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
.picker-section-header:first-child { border-top: none; }
.picker-option .sort-number {
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; border-radius: 50%;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    font-size: 10px; font-weight: 700; flex-shrink: 0;
}
.picker-option .sort-number.empty { background: transparent; border: 1px solid var(--vscode-descriptionForeground); color: transparent; }
.picker-footer { display: flex; justify-content: flex-end; gap: 4px; padding: 6px 10px 4px 10px; border-top: 1px solid var(--vscode-panel-border); margin-top: 2px; }
.picker-footer button { padding: 3px 10px; font-size: 11px; border: none; border-radius: 3px; cursor: pointer; }
.picker-footer button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.picker-footer button.primary:hover { background: var(--vscode-button-hoverBackground); }
.picker-footer button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.picker-footer button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

/* ---- Split handles ---- */
.split-handle { flex: 0 0 4px; cursor: col-resize; background: transparent; transition: background 0.1s; }
.split-handle:hover, .split-handle.dragging { background: var(--vscode-focusBorder); }
.v-split-handle { flex: 0 0 4px; cursor: row-resize; background: transparent; transition: background 0.1s; }
.v-split-handle:hover, .v-split-handle.dragging { background: var(--vscode-focusBorder); }
.v-split-handle.hidden { display: none !important; }

/* ---- Editor pane ---- */
.issues-editor {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
}
.editor-toolbar {
    display: flex; align-items: center; padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBarSectionHeader-background); gap: 4px;
}
.issue-title-bar { flex: 1; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toolbar-icons { display: flex; gap: 2px; align-items: center; }
.status-select { padding: 1px 4px; height: 20px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 3px; font-size: 11px; cursor: pointer; }

/* Comment history */
.comment-history { flex: 1; overflow-y: auto; padding: 8px; min-height: 40px; }
.comment-history.hidden { display: none !important; }
.comment-card { margin-bottom: 10px; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-editor-background); }
.comment-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.comment-avatar { width: 20px; height: 20px; border-radius: 50%; }
.comment-author { font-weight: 600; color: var(--vscode-foreground); }
.comment-body { font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
.comment-body code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
.issue-body-card { border-left: 3px solid var(--vscode-focusBorder); }

/* Attachments */
.attachment-area { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); max-height: 80px; overflow-y: auto; transition: background-color 0.2s; }
.attachment-area.drag-over { background-color: var(--vscode-list-hoverBackground); border: 1px dashed var(--vscode-focusBorder); }
.attachment-list { display: flex; flex-wrap: wrap; gap: 4px; }
.attachment-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; font-size: 11px; cursor: pointer; }
.attachment-chip small { opacity: 0.7; }
.attachment-chip .remove-btn { display: none; cursor: pointer; font-size: 10px; opacity: 0.7; background: none; border: none; color: inherit; padding: 0 2px; }
.attachment-chip:hover .remove-btn { display: inline; }
.attachment-chip:hover .remove-btn:hover { opacity: 1; }

/* Input area */
.input-area { display: flex; flex-direction: row; padding: 6px 8px; gap: 4px; min-height: 60px; flex: 0 0 auto; }
.input-area.expanded { flex: 1; }
.input-column { flex: 1; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
.input-column input[type="text"] { padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 13px; flex: 0 0 auto; }
.input-column input[type="text"]:focus { outline: none; border-color: var(--vscode-focusBorder); }
.input-column textarea { flex: 1; min-height: 40px; resize: none; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 13px; line-height: 1.4; }
.input-column textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
.input-icons { display: flex; flex-direction: column; justify-content: flex-end; gap: 2px; width: 28px; flex-shrink: 0; padding-bottom: 4px; }

/* Labels picker */
.labels-picker { position: absolute; right: 8px; top: 34px; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); z-index: 100; padding: 4px 0; min-width: 160px; }
.label-option { padding: 5px 10px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 6px; }
.label-option:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
.label-option .check-box { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.label-option .check-box .codicon { font-size: 14px; }

/* State indicators */
.empty-state { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
.spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
`;
}

// ============================================================================
// Script  (prefix-scoped IIFE – uses global `vscode` from T3 panel)
// ============================================================================

export function getIssuesScript(prefix: string, mode: PanelMode): string {
    return `
(function() {
    var _p = '${prefix}';
    var _mode = '${mode}';
    function $e(id) { return document.getElementById(_p + '-' + id); }

    // State
    var repos = [];
    var configStatuses = ['open', 'in_triage', 'assigned', 'closed'];
    var statusColors = { open: 'green', in_triage: 'yellow', assigned: 'red', closed: 'grey' };
    var configLabels = [];
    var currentRepo = null;
    var allIssues = [];
    var issues = [];
    var selectedIssue = null;
    var currentComments = [];
    var isNewIssueMode = false;
    var attachments = [];
    var activeFilters = [];
    var activeLabelFilters = {};
    var labelSections = {};
    var sortFields = [];
    // Column system
    var columnDefs = [];
    var visibleColumns = [];
    var manualWidths = {};
    var allReposOption = true;
    var configErrorMsg = null;
    var configSectionName = '';
    var configFilePathStr = '';
    var _isDragging = false;
    var GROWTH_PRIORITY = [];
    var COLUMN_LABELS = {};
    var SORTABLE_FIELDS = [
        { key: 'number', label: 'Number' },
        { key: 'title', label: 'Title' },
        { key: 'state', label: 'Status' },
        { key: 'createdAt', label: 'Created' },
        { key: 'updatedAt', label: 'Updated' },
        { key: 'commentCount', label: 'Comments' },
        { key: 'author', label: 'Author' }
    ];

    // DOM refs
    var repoSelect = $e('repoSelect');
    var filterBtn = $e('filterBtn');
    var sortBtn = $e('sortBtn');
    var refreshBtn = $e('refreshBtn');
    var issueListEl = $e('issueList');
    var addBtn = $e('addBtn');
    var statusSelect = $e('statusSelect');
    var openBrowserBtn = $e('openBrowserBtn');
    var labelsBtn = $e('labelsBtn');
    var sendBtn = $e('sendBtn');
    var attachBtn = $e('attachBtn');
    var titleInput = $e('titleInput');
    var inputText = $e('inputText');
    var commentHistory = $e('commentHistory');
    var attachmentArea = $e('attachmentArea');
    var attachmentListEl = $e('attachmentList');
    var labelsPicker = $e('labelsPicker');
    var issueTitleBar = $e('issueTitle');
    var splitHandle = $e('splitHandle');
    var vSplitHandle = $e('vSplitHandle');
    var browserEl = $e('browser');
    var editorEl = $e('editor');
    var filterPicker = $e('filterPicker');
    var sortPicker = $e('sortPicker');
    var inputArea = $e('inputArea');

    // Init
    vscode.postMessage({ type: 'issuesReady', panelMode: _mode });

    // ---- Message listener (filtered by panelMode) ----
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.panelMode && msg.panelMode !== _mode) return;
        switch (msg.type) {
            case 'issuesInit':
                repos = msg.repos || [];
                configStatuses = msg.statuses || ['open', 'in_triage', 'assigned', 'closed'];
                statusColors = msg.statusColors || {};
                configLabels = msg.labels || [];
                columnDefs = msg.columnDefs || [];
                allReposOption = msg.allReposOption !== false;
                configErrorMsg = msg.configError || null;
                configSectionName = msg.configSection || '';
                configFilePathStr = msg.configFilePath || '';
                COLUMN_LABELS = msg.columnLabels || {};
                GROWTH_PRIORITY = msg.growthPriority || [];
                // Initialize visibleColumns from required + defaultColumns
                var defCols = msg.defaultColumns || [];
                visibleColumns = [];
                for (var ci = 0; ci < columnDefs.length; ci++) {
                    if (columnDefs[ci].required || defCols.indexOf(columnDefs[ci].key) >= 0) {
                        visibleColumns.push(columnDefs[ci].key);
                    }
                }
                labelSections = {};
                for (var li = 0; li < configLabels.length; li++) {
                    var eqi = configLabels[li].indexOf('=');
                    if (eqi > 0) {
                        var lkey = configLabels[li].substring(0, eqi);
                        var lval = configLabels[li].substring(eqi + 1);
                        if (!labelSections[lkey]) labelSections[lkey] = [];
                        labelSections[lkey].push(lval);
                    }
                }
                manualWidths = {};
                if (configErrorMsg) { showConfigError(); }
                else { renderRepoDropdown(); }
                break;

            case 'issues':
                if (currentRepo && currentRepo.id === '__all__') {
                    var tagged = (msg.issues || []).map(function(iss) { iss._repoId = msg.repoId; return iss; });
                    allIssues = allIssues.concat(tagged);
                } else {
                    allIssues = (msg.issues || []).map(function(iss) { iss._repoId = msg.repoId; return iss; });
                }
                applyFilterAndSort();
                renderIssueList();
                break;

            case 'comments':
                currentComments = msg.comments || [];
                renderComments();
                break;

            case 'issueCreated':
                isNewIssueMode = false;
                selectedIssue = msg.issue;
                loadIssues();
                loadComments();
                renderEditorState();
                break;

            case 'commentAdded':
                currentComments.push(msg.comment);
                renderComments();
                inputText.value = '';
                break;

            case 'issueUpdated':
                if (selectedIssue && selectedIssue.number === msg.issue.number) {
                    selectedIssue = msg.issue;
                    renderEditorState();
                }
                loadIssues();
                break;

            case 'attachmentsPicked':
                if (selectedIssue && !isNewIssueMode) {
                    // Upload to provider/server
                    uploadPickedAttachments(msg.attachments);
                } else {
                    // New issue mode: just add to local list
                    for (var i = 0; i < msg.attachments.length; i++) { attachments.push(msg.attachments[i]); }
                    renderAttachments();
                }
                break;

            case 'attachmentUploaded':
                _attachmentUploading = false;
                attachments.push(msg.attachment);
                renderAttachments();
                break;

            case 'attachmentsList':
                attachments = msg.attachments || [];
                renderAttachments();
                break;

            case 'attachmentDeleted':
                attachments = attachments.filter(function(a) { return a.id !== msg.attachmentId; });
                renderAttachments();
                break;

            case 'issuesError':
                _attachmentUploading = false;
                showError(msg.message);
                break;
        }
    });

    // ---- Effective status ----
    function getEffectiveStatus(issue) {
        if (issue.state === 'closed') return 'closed';
        var labels = issue.labels || [];
        var labelStatuses = configStatuses.filter(function(s) { return s !== 'open' && s !== 'closed'; });
        for (var i = 0; i < labelStatuses.length; i++) {
            if (labels.indexOf(labelStatuses[i]) >= 0) return labelStatuses[i];
        }
        return 'open';
    }

    // ---- Filter & Sort ----
    function applyFilterAndSort() {
        issues = allIssues.filter(function(iss) {
            // Status section: empty = any
            if (activeFilters.length > 0) {
                if (activeFilters.indexOf(getEffectiveStatus(iss)) < 0) return false;
            }
            // Label sections: each section with selections must match
            var lkeys = Object.keys(activeLabelFilters);
            for (var lk = 0; lk < lkeys.length; lk++) {
                var vals = activeLabelFilters[lkeys[lk]];
                if (!vals || vals.length === 0) continue;
                var matched = false;
                var issLabels = iss.labels || [];
                for (var lv = 0; lv < vals.length; lv++) {
                    if (issLabels.indexOf(lkeys[lk] + '=' + vals[lv]) >= 0) { matched = true; break; }
                }
                if (!matched) return false;
            }
            return true;
        });
        if (sortFields.length > 0) {
            issues.sort(function(a, b) {
                for (var i = 0; i < sortFields.length; i++) {
                    var va = getSortValue(a, sortFields[i]);
                    var vb = getSortValue(b, sortFields[i]);
                    if (va < vb) return -1;
                    if (va > vb) return 1;
                }
                return 0;
            });
        }
    }
    function getSortValue(issue, field) {
        switch (field) {
            case 'number': return issue.number || 0;
            case 'title': return (issue.title || '').toLowerCase();
            case 'state': return getEffectiveStatus(issue);
            case 'createdAt': return issue.createdAt || '';
            case 'updatedAt': return issue.updatedAt || '';
            case 'commentCount': return issue.commentCount || 0;
            case 'author': return (issue.author && issue.author.name || '').toLowerCase();
            default: return '';
        }
    }

    // ---- Repo dropdown ----
    function renderRepoDropdown() {
        var html = '<option value="">-- Select Repo --</option>';
        if (allReposOption) { html += '<option value="__all__">All Repos</option>'; }
        for (var i = 0; i < repos.length; i++) {
            html += '<option value="' + escapeHtml(repos[i].id) + '">' + escapeHtml(repos[i].displayName) + '</option>';
        }
        repoSelect.innerHTML = html;
        // Preselect: first additional repo (has ': ' in name), else All Repos if available, else first repo
        var preselected = '';
        for (var j = 0; j < repos.length; j++) {
            if (repos[j].displayName.indexOf(': ') >= 0) { preselected = repos[j].id; break; }
        }
        if (!preselected && repos.length > 0) {
            preselected = allReposOption ? '__all__' : repos[0].id;
        }
        if (preselected) {
            repoSelect.value = preselected;
            repoSelect.dispatchEvent(new Event('change'));
        }
    }
    repoSelect.addEventListener('change', function() {
        var val = repoSelect.value;
        if (val === '' || val === '__all__') {
            currentRepo = val === '__all__' ? { id: '__all__', displayName: 'All Repos' } : null;
            if (val === '__all__') { loadAllIssues(); }
            else { allIssues = []; issues = []; renderIssueList(); }
        } else {
            currentRepo = null;
            for (var i = 0; i < repos.length; i++) { if (repos[i].id === val) { currentRepo = repos[i]; break; } }
            loadIssues();
        }
        selectedIssue = null;
        currentComments = [];
        renderEditorState();
    });
    refreshBtn.addEventListener('click', function() {
        if (currentRepo && currentRepo.id === '__all__') { loadAllIssues(); }
        else if (currentRepo) { loadIssues(); }
    });

    function loadIssues() {
        if (!currentRepo || currentRepo.id === '__all__') return;
        allIssues = [];
        issueListEl.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
        vscode.postMessage({ type: 'loadIssues', repoId: currentRepo.id, state: 'all', panelMode: _mode });
    }
    function loadAllIssues() {
        allIssues = [];
        issueListEl.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
        if (repos.length === 0) { issues = []; renderIssueList(); return; }
        for (var i = 0; i < repos.length; i++) {
            vscode.postMessage({ type: 'loadIssues', repoId: repos[i].id, state: 'all', panelMode: _mode });
        }
    }
    function loadComments() {
        if (!selectedIssue || !currentRepo) return;
        var repoId = selectedIssue._repoId || currentRepo.id;
        vscode.postMessage({ type: 'loadComments', repoId: repoId, issueNumber: selectedIssue.number, panelMode: _mode });
    }

    // ---- Filter picker ----
    filterBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (filterPicker.style.display !== 'none') { filterPicker.style.display = 'none'; return; }
        sortPicker.style.display = 'none';
        renderFilterPicker();
        filterPicker.style.display = '';
    });
    function renderFilterPicker() {
        var presentStatuses = {};
        for (var i = 0; i < allIssues.length; i++) { presentStatuses[getEffectiveStatus(allIssues[i])] = true; }
        var html = '<div class="picker-section-header">Status</div>';
        for (var j = 0; j < configStatuses.length; j++) {
            var st = configStatuses[j];
            var checked = activeFilters.indexOf(st) >= 0;
            var present = presentStatuses[st];
            html += '<div class="picker-option' + (present ? '' : ' dimmed') + '" data-section="status" data-value="' + escapeHtml(st) + '">';
            html += '<span class="check-box">' + (checked ? '<span class="codicon codicon-check"></span>' : '') + '</span>';
            html += '<span>' + escapeHtml(formatStatusLabel(st)) + '</span></div>';
        }
        var sectionKeys = Object.keys(labelSections);
        for (var sk = 0; sk < sectionKeys.length; sk++) {
            var secKey = sectionKeys[sk];
            var secVals = labelSections[secKey];
            html += '<div class="picker-section-header">' + escapeHtml(formatStatusLabel(secKey)) + '</div>';
            var secFilters = activeLabelFilters[secKey] || [];
            for (var sv = 0; sv < secVals.length; sv++) {
                var lChecked = secFilters.indexOf(secVals[sv]) >= 0;
                html += '<div class="picker-option" data-section="' + escapeHtml(secKey) + '" data-value="' + escapeHtml(secVals[sv]) + '">';
                html += '<span class="check-box">' + (lChecked ? '<span class="codicon codicon-check"></span>' : '') + '</span>';
                html += '<span>' + escapeHtml(secVals[sv]) + '</span></div>';
            }
        }
        filterPicker.innerHTML = html;
        filterPicker.querySelectorAll('.picker-option').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                var section = el.dataset.section;
                var value = el.dataset.value;
                if (section === 'status') {
                    var idx = activeFilters.indexOf(value);
                    if (idx >= 0) { activeFilters.splice(idx, 1); } else { activeFilters.push(value); }
                } else {
                    if (!activeLabelFilters[section]) activeLabelFilters[section] = [];
                    var lidx = activeLabelFilters[section].indexOf(value);
                    if (lidx >= 0) { activeLabelFilters[section].splice(lidx, 1); } else { activeLabelFilters[section].push(value); }
                }
                applyFilterAndSort();
                renderIssueList();
                renderFilterPicker();
                updateFilterBtnState();
            });
        });
    }
    function updateFilterBtnState() {
        var isDefault = (activeFilters.length === 0);
        if (isDefault) {
            var lkeys = Object.keys(activeLabelFilters);
            for (var i = 0; i < lkeys.length; i++) {
                if (activeLabelFilters[lkeys[i]] && activeLabelFilters[lkeys[i]].length > 0) { isDefault = false; break; }
            }
        }
        if (isDefault) { filterBtn.classList.remove('active-indicator'); }
        else { filterBtn.classList.add('active-indicator'); }
    }
    function updateSortBtnState() {
        var isDefault = (sortFields.length === 0);
        if (isDefault) { sortBtn.classList.remove('active-indicator'); }
        else { sortBtn.classList.add('active-indicator'); }
    }

    // ---- Sort picker ----
    var pendingSortFields = [];
    sortBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (sortPicker.style.display !== 'none') { sortPicker.style.display = 'none'; return; }
        filterPicker.style.display = 'none';
        pendingSortFields = sortFields.slice();
        renderSortPicker();
        sortPicker.style.display = '';
    });
    function renderSortPicker() {
        var html = '';
        for (var i = 0; i < SORTABLE_FIELDS.length; i++) {
            var f = SORTABLE_FIELDS[i];
            var order = pendingSortFields.indexOf(f.key);
            var hasOrder = order >= 0;
            html += '<div class="picker-option" data-field="' + f.key + '">';
            html += '<span class="sort-number ' + (hasOrder ? '' : 'empty') + '">' + (hasOrder ? (order + 1) : '') + '</span>';
            html += '<span>' + escapeHtml(f.label) + '</span></div>';
        }
        html += '<div class="picker-footer">';
        html += '<button class="secondary" id="' + _p + '-sortReset">Reset</button>';
        html += '<button class="primary" id="' + _p + '-sortOk">OK</button>';
        html += '</div>';
        sortPicker.innerHTML = html;
        sortPicker.querySelectorAll('.picker-option').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                var field = el.dataset.field;
                var idx = pendingSortFields.indexOf(field);
                if (idx >= 0) { pendingSortFields.splice(idx, 1); } else { pendingSortFields.push(field); }
                renderSortPicker();
            });
        });
        $e('sortReset').addEventListener('click', function(e) { e.stopPropagation(); pendingSortFields = []; renderSortPicker(); });
        $e('sortOk').addEventListener('click', function(e) {
            e.stopPropagation(); sortFields = pendingSortFields.slice();
            sortPicker.style.display = 'none'; applyFilterAndSort(); renderIssueList();
            updateSortBtnState();
        });
    }

    // ---- Issue list - Column system ----
    function getStatusColor(status) {
        return statusColors[status] || 'grey';
    }
    function getColumnValue(issue, colKey) {
        var effStatus = getEffectiveStatus(issue);
        switch (colKey) {
            case 'statusDot': return { type: 'dot', color: getStatusColor(effStatus) };
            case 'id': return '#' + issue.number;
            case 'title': return issue.title || '';
            case 'repository': {
                var rid = issue._repoId || '';
                var slash = rid.lastIndexOf('/');
                return slash >= 0 ? rid.substring(slash + 1) : rid;
            }
            case 'repositoryOwner': {
                var rid2 = issue._repoId || '';
                var slash2 = rid2.indexOf('/');
                return slash2 >= 0 ? rid2.substring(0, slash2) : '';
            }
            case 'status': return formatStatusLabel(effStatus);
            case 'author': return issue.author ? issue.author.name : '';
            case 'commentCount': return (issue.commentCount || 0) + '';
            case 'creationTimestamp': return formatDateYYMMDD(issue.createdAt);
            case 'updateTimestamp': return formatDateYYMMDD(issue.updatedAt);
            case 'labels': {
                var lbls = (issue.labels || []).map(function(l) {
                    var eq = l.indexOf('=');
                    return eq > 0 ? l.substring(eq + 1) : l;
                });
                return lbls.join(', ');
            }
            default: return '';
        }
    }
    function getVisibleColumnDefs() {
        return columnDefs.filter(function(cd) { return visibleColumns.indexOf(cd.key) >= 0; });
    }
    function calculateColumnWidths(containerWidth) {
        var visCols = getVisibleColumnDefs();
        var totalBorders = Math.max(0, visCols.length - 1);
        var available = containerWidth - totalBorders;
        var widths = {};
        var remaining = available;
        for (var i = 0; i < visCols.length; i++) {
            var w = manualWidths[visCols[i].key] || visCols[i].minWidth;
            widths[visCols[i].key] = w;
            remaining -= w;
        }
        if (remaining > 0) {
            for (var gi = 0; gi < GROWTH_PRIORITY.length && remaining > 0; gi++) {
                var gk = GROWTH_PRIORITY[gi];
                var col = null;
                for (var ci = 0; ci < visCols.length; ci++) {
                    if (visCols[ci].key === gk) { col = visCols[ci]; break; }
                }
                if (!col || manualWidths[gk]) continue;
                var canGrow = col.maxWidth - widths[gk];
                if (canGrow <= 0) continue;
                var give = Math.min(canGrow, remaining);
                widths[gk] += give;
                remaining -= give;
            }
        }
        return widths;
    }
    function renderIssueList() {
        if (configErrorMsg) { showConfigError(); return; }
        if (issues.length === 0) { issueListEl.innerHTML = '<div class="empty-state">No issues found</div>'; return; }
        var cw = issueListEl.clientWidth || 280;
        var widths = calculateColumnWidths(cw);
        var visCols = getVisibleColumnDefs();
        var html = '';
        for (var i = 0; i < issues.length; i++) {
            var issue = issues[i];
            var sel = selectedIssue && selectedIssue.id === issue.id ? ' selected' : '';
            html += '<div class="issue-row' + sel + '" data-idx="' + i + '">';
            for (var ci = 0; ci < visCols.length; ci++) {
                var cd = visCols[ci];
                var w = widths[cd.key] || cd.minWidth;
                var val = getColumnValue(issue, cd.key);
                if (cd.key === 'statusDot') {
                    html += '<span class="issue-cell cell-style-' + (cd.style || 'dot') + '" style="width:' + w + 'px"><span class="issue-state-dot" style="background:' + escapeHtml(val.color) + ';"></span></span>';
                } else {
                    var text = typeof val === 'string' ? val : '';
                    var label = COLUMN_LABELS[cd.key] || cd.key;
                    html += '<span class="issue-cell cell-style-' + (cd.style || 'grey') + '" style="width:' + w + 'px" title="' + escapeHtml(label + ': ' + text) + '">' + escapeHtml(text) + '</span>';
                }
            }
            html += '</div>';
        }
        html += '<div class="col-resize-handles">';
        var cumX = 0;
        for (var ri = 0; ri < visCols.length - 1; ri++) {
            cumX += (widths[visCols[ri].key] || visCols[ri].minWidth) + 1;
            html += '<div class="col-resize-handle" data-col-idx="' + ri + '" style="left:' + (cumX - 3) + 'px"></div>';
        }
        html += '</div>';
        issueListEl.innerHTML = html;
        issueListEl.querySelectorAll('.issue-row').forEach(function(el) {
            el.addEventListener('click', function() { selectIssue(issues[parseInt(el.dataset.idx)]); });
            el.addEventListener('contextmenu', function(e) { e.preventDefault(); showColumnPicker(e.clientX, e.clientY); });
        });
        setupResizeHandles();
    }
    function setupResizeHandles() {
        issueListEl.querySelectorAll('.col-resize-handle').forEach(function(handle) {
            handle.addEventListener('mousedown', function(e) {
                e.preventDefault();
                e.stopPropagation();
                var colIdx = parseInt(handle.dataset.colIdx);
                var visCols = getVisibleColumnDefs();
                if (colIdx >= visCols.length) return;
                var colKey = visCols[colIdx].key;
                var startX = e.clientX;
                var startW = visCols[colIdx].minWidth;
                var firstRow = issueListEl.querySelector('.issue-row');
                if (firstRow) {
                    var cells = firstRow.querySelectorAll('.issue-cell');
                    if (cells[colIdx]) startW = cells[colIdx].offsetWidth;
                }
                _isDragging = true;
                function onMove(ev) {
                    var dx = ev.clientX - startX;
                    manualWidths[colKey] = Math.max(visCols[colIdx].minWidth, startW + dx);
                    renderIssueList();
                }
                function onUp() {
                    _isDragging = false;
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                }
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
    }
    // Reset manual widths on container resize (skip during drag)
    var _resizeTimer = null;
    var _lastListWidth = 0;
    (new ResizeObserver(function(entries) {
        if (_isDragging) return;
        var w = entries[0].contentRect.width;
        if (Math.abs(w - _lastListWidth) > 2) {
            _lastListWidth = w;
            manualWidths = {};
            clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(function() { renderIssueList(); }, 50);
        }
    })).observe(issueListEl);
    function showColumnPicker(x, y) {
        var picker = $e('columnPicker');
        if (!picker) return;
        var optionalCols = columnDefs.filter(function(cd) { return !cd.required; });
        var html = '<div class="picker-section-header">Columns</div>';
        for (var i = 0; i < optionalCols.length; i++) {
            var col = optionalCols[i];
            var checked = visibleColumns.indexOf(col.key) >= 0;
            var label = COLUMN_LABELS[col.key] || col.key;
            html += '<div class="picker-option" data-col="' + col.key + '">';
            html += '<span class="check-box">' + (checked ? '<span class="codicon codicon-check"></span>' : '') + '</span>';
            html += '<span>' + escapeHtml(label) + '</span></div>';
        }
        picker.innerHTML = html;
        picker.style.display = '';
        picker.style.left = x + 'px';
        picker.style.top = y + 'px';
        requestAnimationFrame(function() {
            var rect = picker.getBoundingClientRect();
            if (rect.right > window.innerWidth) picker.style.left = Math.max(0, x - rect.width) + 'px';
            if (rect.bottom > window.innerHeight) picker.style.top = Math.max(0, y - rect.height) + 'px';
        });
        picker.querySelectorAll('.picker-option').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                var colKey = el.dataset.col;
                var idx = visibleColumns.indexOf(colKey);
                if (idx >= 0) { visibleColumns.splice(idx, 1); } else { visibleColumns.push(colKey); }
                manualWidths = {};
                showColumnPicker(x, y);
                renderIssueList();
            });
        });
    }
    function showConfigError() {
        var html = '<div class="config-error">';
        html += '<h3>Configuration Error</h3>';
        html += '<p>' + escapeHtml(configErrorMsg) + '</p>';
        html += '<p>Fix the configuration in section <code>' + escapeHtml(configSectionName) + '</code></p>';
        if (configFilePathStr) {
            html += '<p>Config file: <a class="config-file-link" href="#">' + escapeHtml(configFilePathStr) + '</a></p>';
        }
        html += '<p style="margin-top:8px;font-size:11px;color:var(--vscode-descriptionForeground)">Column format: <code>columnName{style}[minWidth,maxWidth]</code> or <code>columnName{style}[minWidth,maxWidth]*</code> for required columns.</p>';
        html += '</div>';
        issueListEl.innerHTML = html;
        var link = issueListEl.querySelector('.config-file-link');
        if (link) {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                vscode.postMessage({ type: 'openConfigFile', panelMode: _mode });
            });
        }
    }
    // Close column picker on outside click
    document.addEventListener('click', function() {
        var picker = $e('columnPicker');
        if (picker) picker.style.display = 'none';
    });
    function selectIssue(issue) {
        selectedIssue = issue;
        isNewIssueMode = false;
        currentComments = [];
        attachments = [];
        renderEditorState();
        renderIssueList();
        loadComments();
        loadAttachments();
    }

    // ---- Editor state ----
    function renderEditorState() {
        if (isNewIssueMode) {
            issueTitleBar.textContent = 'New Issue';
            commentHistory.classList.add('hidden');
            vSplitHandle.classList.add('hidden');
            commentHistory.style.flex = '';
            inputArea.classList.add('expanded');
            inputArea.style.flex = '';
            titleInput.style.display = '';
            titleInput.value = '';
            inputText.placeholder = 'Issue body (optional)…';
            statusSelect.style.display = 'none';
            openBrowserBtn.style.display = 'none';
            labelsBtn.style.display = 'none';
        } else {
            commentHistory.classList.remove('hidden');
            vSplitHandle.classList.remove('hidden');
            commentHistory.style.flex = '';
            inputArea.classList.remove('expanded');
            inputArea.style.flex = '';
            titleInput.style.display = 'none';
            if (selectedIssue) {
                issueTitleBar.textContent = '#' + selectedIssue.number + ' ' + selectedIssue.title;
                inputText.placeholder = 'Write a comment…';
                var effStatus = getEffectiveStatus(selectedIssue);
                var optHtml = '';
                for (var i = 0; i < configStatuses.length; i++) {
                    var st = configStatuses[i];
                    optHtml += '<option value="' + escapeHtml(st) + '"' + (effStatus === st ? ' selected' : '') + '>' + escapeHtml(formatStatusLabel(st)) + '</option>';
                }
                statusSelect.innerHTML = optHtml;
                statusSelect.style.display = '';
                openBrowserBtn.style.display = '';
                labelsBtn.style.display = '';
                renderComments();
            } else {
                issueTitleBar.textContent = 'No issue selected';
                commentHistory.innerHTML = '<div class="empty-state">Select an issue from the list</div>';
                inputText.placeholder = 'Write a comment…';
                statusSelect.style.display = 'none';
                openBrowserBtn.style.display = 'none';
                labelsBtn.style.display = 'none';
            }
        }
    }

    // ---- Comments ----
    function renderComments() {
        if (!selectedIssue) return;
        var html = '';
        html += '<div class="comment-card issue-body-card"><div class="comment-header">';
        html += '<img class="comment-avatar" src="' + escapeHtml(selectedIssue.author.avatarUrl) + '" />';
        html += '<span class="comment-author">' + escapeHtml(selectedIssue.author.name) + '</span>';
        html += '<span>' + formatDate(selectedIssue.createdAt) + '</span></div>';
        html += '<div class="comment-body">' + escapeHtml(selectedIssue.body || '(No description)') + '</div></div>';
        for (var i = 0; i < currentComments.length; i++) {
            var c = currentComments[i];
            html += '<div class="comment-card"><div class="comment-header">';
            html += '<img class="comment-avatar" src="' + escapeHtml(c.author.avatarUrl) + '" />';
            html += '<span class="comment-author">' + escapeHtml(c.author.name) + '</span>';
            html += '<span>' + formatDate(c.createdAt) + '</span></div>';
            html += '<div class="comment-body">' + escapeHtml(c.body) + '</div></div>';
        }
        commentHistory.innerHTML = html;
        commentHistory.scrollTop = commentHistory.scrollHeight;
    }

    // ---- New issue ----
    addBtn.addEventListener('click', function() {
        isNewIssueMode = true; attachments = []; titleInput.value = ''; inputText.value = '';
        renderAttachments(); renderEditorState();
    });

    // ---- Status dropdown ----
    statusSelect.addEventListener('change', function() {
        if (!selectedIssue || !currentRepo) return;
        var repoId = selectedIssue._repoId || currentRepo.id;
        vscode.postMessage({ type: 'changeStatus', repoId: repoId, issueNumber: selectedIssue.number, status: statusSelect.value, panelMode: _mode });
    });

    // ---- Open in browser ----
    openBrowserBtn.addEventListener('click', function() {
        if (selectedIssue && selectedIssue.url) { vscode.postMessage({ type: 'openExternal', url: selectedIssue.url, panelMode: _mode }); }
    });

    // ---- Labels picker ----
    labelsBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (labelsPicker.style.display !== 'none') { labelsPicker.style.display = 'none'; return; }
        showLabelsPicker();
    });
    function showLabelsPicker() {
        if (!selectedIssue) return;
        var currentLabels = selectedIssue.labels || [];
        var html = '';
        for (var i = 0; i < configLabels.length; i++) {
            var label = configLabels[i];
            var eqIdx = label.indexOf('=');
            var displayName = eqIdx > 0 ? label.substring(eqIdx + 1) : label;
            var hasLabel = currentLabels.indexOf(label) >= 0;
            html += '<div class="label-option" data-label="' + escapeHtml(label) + '">';
            html += '<span class="check-box">' + (hasLabel ? '<span class="codicon codicon-check"></span>' : '') + '</span>';
            html += '<span>' + escapeHtml(displayName) + '</span></div>';
        }
        labelsPicker.innerHTML = html;
        labelsPicker.style.display = '';
        labelsPicker.querySelectorAll('.label-option').forEach(function(el) {
            el.addEventListener('click', function() {
                if (!selectedIssue || !currentRepo) return;
                var repoId = selectedIssue._repoId || currentRepo.id;
                vscode.postMessage({ type: 'toggleLabel', repoId: repoId, issueNumber: selectedIssue.number, label: el.dataset.label, panelMode: _mode });
                labelsPicker.style.display = 'none';
            });
        });
    }

    // Close pickers on outside click (scoped to this panel's pickers)
    document.addEventListener('click', function() {
        filterPicker.style.display = 'none';
        sortPicker.style.display = 'none';
        labelsPicker.style.display = 'none';
    });

    // ---- Send ----
    sendBtn.addEventListener('click', function() {
        if (isNewIssueMode) {
            var title = titleInput.value.trim();
            if (!title) { showError('Please enter a title'); return; }
            if (!currentRepo || currentRepo.id === '__all__') { showError('Please select a specific repo to create an issue'); return; }
            var body = inputText.value.trim();
            if (attachments.length > 0) {
                body += '\\n\\n---\\nAttachments:\\n';
                for (var i = 0; i < attachments.length; i++) { body += '- ' + attachments[i].name + '\\n'; }
            }
            vscode.postMessage({ type: 'createIssue', repoId: currentRepo.id, title: title, body: body, panelMode: _mode });
        } else if (selectedIssue) {
            var text = inputText.value.trim();
            if (!text) return;
            var repoId = selectedIssue._repoId || currentRepo.id;
            var commentBody = text;
            if (attachments.length > 0) {
                commentBody += '\\n\\n---\\nAttachments:\\n';
                for (var j = 0; j < attachments.length; j++) { commentBody += '- ' + attachments[j].name + '\\n'; }
            }
            vscode.postMessage({ type: 'addComment', repoId: repoId, issueNumber: selectedIssue.number, body: commentBody, panelMode: _mode });
            attachments = [];
            renderAttachments();
        }
    });

    // ---- Attachments ----
    var _attachmentUploading = false;

    attachBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'pickAttachment', panelMode: _mode });
    });

    function loadAttachments() {
        if (!selectedIssue || !currentRepo) return;
        var repoId = selectedIssue._repoId || currentRepo.id;
        vscode.postMessage({ type: 'listAttachments', repoId: repoId, issueNumber: selectedIssue.number, panelMode: _mode });
    }

    function uploadPickedAttachments(picked) {
        if (!selectedIssue || !currentRepo || picked.length === 0) return;
        var repoId = selectedIssue._repoId || currentRepo.id;
        _attachmentUploading = true;
        renderAttachments();
        var remaining = picked.length;
        for (var i = 0; i < picked.length; i++) {
            vscode.postMessage({
                type: 'uploadAttachment', repoId: repoId,
                issueNumber: selectedIssue.number,
                filePath: picked[i].path, fileName: picked[i].name,
                panelMode: _mode
            });
        }
    }

    function deleteAttachment(idx) {
        if (!selectedIssue || !currentRepo) return;
        var att = attachments[idx];
        if (!att) return;
        var repoId = selectedIssue._repoId || currentRepo.id;
        vscode.postMessage({
            type: 'deleteAttachment', repoId: repoId,
            issueNumber: selectedIssue.number,
            attachmentId: att.id,
            panelMode: _mode
        });
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function renderAttachments() {
        if (attachments.length === 0 && !_attachmentUploading) {
            attachmentArea.style.display = 'none'; return;
        }
        attachmentArea.style.display = '';
        var html = '';
        if (_attachmentUploading) {
            html += '<span class="attachment-chip"><span class="codicon codicon-loading codicon-modifier-spin"></span> Uploading...</span>';
        }
        for (var i = 0; i < attachments.length; i++) {
            var a = attachments[i];
            html += '<span class="attachment-chip" data-idx="' + i + '" title="' + escapeHtml(a.name) + ' (' + formatSize(a.size || 0) + ')">';
            html += '<span class="codicon codicon-file"></span>';
            html += escapeHtml(a.name);
            if (a.size) html += ' <small>(' + formatSize(a.size) + ')</small>';
            html += '<button class="remove-btn" data-aidx="' + i + '" title="Remove">&times;</button></span>';
        }
        attachmentListEl.innerHTML = html;
        // Chip click = open/preview
        attachmentListEl.querySelectorAll('.attachment-chip').forEach(function(chip) {
            chip.addEventListener('click', function(e) {
                if (e.target.classList.contains('remove-btn')) return;
                var idx = parseInt(chip.dataset.idx);
                if (attachments[idx] && attachments[idx].url) {
                    vscode.postMessage({ type: 'openExternal', url: attachments[idx].url, panelMode: _mode });
                }
            });
        });
        // Remove button
        attachmentListEl.querySelectorAll('.remove-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var idx = parseInt(btn.dataset.aidx);
                if (selectedIssue && !isNewIssueMode) {
                    deleteAttachment(idx);
                } else {
                    attachments.splice(idx, 1);
                    renderAttachments();
                }
            });
        });
    }

    // ---- Drag & drop support for attachments ----
    attachmentArea.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        attachmentArea.style.display = '';
        attachmentArea.classList.add('drag-over');
    });
    attachmentArea.addEventListener('dragleave', function(e) {
        attachmentArea.classList.remove('drag-over');
    });
    attachmentArea.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        attachmentArea.classList.remove('drag-over');
        // Webview doesn't give real file paths from drag events, so trigger file picker instead
        vscode.postMessage({ type: 'pickAttachment', panelMode: _mode });
    });

    // ---- Horizontal split resize ----
    (function() {
        var dragging = false, startX, startWidth;
        splitHandle.addEventListener('mousedown', function(e) {
            e.preventDefault(); dragging = true; startX = e.clientX; startWidth = browserEl.offsetWidth;
            splitHandle.classList.add('dragging');
            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
        });
        function onMove(e) { if (!dragging) return; var dx = e.clientX - startX; browserEl.style.flex = '0 0 ' + Math.max(120, Math.min(startWidth + dx, window.innerWidth - 200)) + 'px'; }
        function onUp() { dragging = false; splitHandle.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    })();

    // ---- Vertical split resize ----
    (function() {
        var dragging = false, startY, startCommentH, startInputH;
        vSplitHandle.addEventListener('mousedown', function(e) {
            e.preventDefault(); dragging = true; startY = e.clientY;
            startCommentH = commentHistory.offsetHeight; startInputH = inputArea.offsetHeight;
            vSplitHandle.classList.add('dragging');
            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
        });
        function onMove(e) { if (!dragging) return; var dy = e.clientY - startY; commentHistory.style.flex = '0 0 ' + Math.max(40, startCommentH + dy) + 'px'; inputArea.style.flex = '0 0 ' + Math.max(40, startInputH - dy) + 'px'; }
        function onUp() { dragging = false; vSplitHandle.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    })();

    // ---- Utility ----
    function escapeHtml(str) { if (!str) return ''; return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function formatDate(iso) { try { var d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch(e) { return iso; } }
    function formatDateYYMMDD(iso) {
        if (!iso) return '';
        try {
            var d = new Date(iso);
            var yy = String(d.getFullYear()).substring(2);
            var mm = String(d.getMonth() + 1).padStart(2, '0');
            var dd = String(d.getDate()).padStart(2, '0');
            var result = yy + mm + dd;
            var hh = d.getHours(); var min = d.getMinutes();
            if (hh !== 0 || min !== 0 || d.getSeconds() !== 0) {
                result += ' ' + String(hh).padStart(2, '0') + ':' + String(min).padStart(2, '0');
            }
            return result;
        } catch(e) { return iso; }
    }
    function formatStatusLabel(st) { return st.replace(/_/g, ' ').replace(/\\b[a-z]/g, function(c) { return c.toUpperCase(); }); }
    function showError(msg) {
        var div = document.createElement('div'); div.className = 'empty-state'; div.style.color = 'var(--vscode-errorForeground)'; div.textContent = msg;
        commentHistory.appendChild(div); setTimeout(function() { if (div.parentNode) div.parentNode.removeChild(div); }, 5000);
    }
})();
`;
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
