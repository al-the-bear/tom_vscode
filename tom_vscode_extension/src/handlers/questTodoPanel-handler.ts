/**
 * Quest TODO Panel — §4
 *
 * Originally a standalone webview view, now embedded as a section
 * inside the T3 panel accordion.  Exports HTML fragment, CSS,
 * script, and message handler for accordion integration.
 *
 * Shows a two-pane layout:
 *   Left  → scrollable todo list (status-color-coded, click to select)
 *   Right → todo detail editor with full schema fields
 *
 * All YAML operations use the CST-preserving `questTodoManager`.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { ChatVariablesStore } from '../managers/chatVariablesStore.js';
import * as questTodo from '../managers/questTodoManager.js';
import { collectAllTags, readAllQuestsTodos, readWorkspaceTodos, listQuestIds, listWorkspaceTodoFiles, scanWorkspaceProjects, collectScopeValues } from '../managers/questTodoManager.js';
import { WindowSessionTodoStore } from '../managers/windowSessionTodoStore.js';
import { WsPaths } from '../utils/workspacePaths';
import { getExternalApplicationForFile, openInExternalApplication, resolvePathVariables, applyDefaultTemplate, DEFAULT_ANSWER_FILE_TEMPLATE } from './handler_shared';
import { expandTemplate } from './promptTemplate';
import { loadSendToChatConfig } from '../utils/sendToChatConfig';

// Module-level state
let _extensionContext: vscode.ExtensionContext | undefined;
let _popoutPanel: vscode.WebviewPanel | undefined;
const _webviewConfigs = new WeakMap<vscode.Webview, QuestTodoViewConfig>();

/** Storage key for persisting Quest TODO panel state per workspace. */
const QT_STATE_KEY = 'qt.panelState';
const QT_PENDING_SELECT_KEY = 'qt.pendingSelect';

interface QtPanelState {
    questId?: string;
    file?: string;
    tagScope?: 'quest' | 'all';
    sortFields?: { field: string; asc: boolean }[];
    filterState?: {
        status?: string[];
        priority?: string[];
        tags?: string[];
        createdFrom?: string;
        createdTo?: string;
        updatedFrom?: string;
        updatedTo?: string;
        completedFrom?: string;
        completedTo?: string;
    };
}

interface QtPendingSelectState {
    file?: string;
    todoId?: string;
}

function _loadPanelState(): QtPanelState {
    return _extensionContext?.workspaceState.get<QtPanelState>(QT_STATE_KEY) ?? {};
}

function _loadPendingSelectState(): QtPendingSelectState {
    return _extensionContext?.workspaceState.get<QtPendingSelectState>(QT_PENDING_SELECT_KEY) ?? {};
}

async function _savePendingSelectState(state: QtPendingSelectState): Promise<void> {
    await _extensionContext?.workspaceState.update(QT_PENDING_SELECT_KEY, state);
}

async function _clearPendingSelectState(): Promise<void> {
    await _extensionContext?.workspaceState.update(QT_PENDING_SELECT_KEY, undefined);
}

async function _savePanelState(state: QtPanelState): Promise<void> {
    await _extensionContext?.workspaceState.update(QT_STATE_KEY, state);
}

export interface QuestTodoViewConfig {
    mode?: 'default' | 'fixed-file' | 'workspace-file' | 'session';
    fixedQuestId?: string;
    fixedFile?: string;
    fixedFilePath?: string;
    fixedFileLabel?: string;
    hideQuestSelect?: boolean;
    hideFileSelect?: boolean;
    disableFileActions?: boolean;
}

/** Call once from extension.ts / t3Panel to store the extension context. */
export function setQuestTodoContext(ctx: vscode.ExtensionContext): void {
    _extensionContext = ctx;
}

// ---- Global provider references for cross-module access ----
let _questTodosProvider: QuestTodoEmbeddedViewProvider | undefined;
let _sessionTodosProvider: QuestTodoEmbeddedViewProvider | undefined;

/** Register the quest-todos provider instance for cross-module access. */
export function setQuestTodosProvider(provider: QuestTodoEmbeddedViewProvider): void {
    _questTodosProvider = provider;
}

/** Register the session-todos provider instance for cross-module access. */
export function setSessionTodosProvider(provider: QuestTodoEmbeddedViewProvider): void {
    _sessionTodosProvider = provider;
}

/** Refresh the session todo panel (e.g. after copilot tool adds a session todo). */
export function refreshSessionPanel(): void {
    _sessionTodosProvider?.refresh();
}

/** Backup a session todo before deletion (called from copilot tools). */
export function backupSessionTodo(todoId: string): void {
    try {
        const sessionFp = WindowSessionTodoStore.instance.filePath;
        _moveToBackup(sessionFp, todoId);
    } catch { /* best-effort backup */ }
}



/**
 * Select a todo in the bottom-panel T3 Quest TODO accordion and focus it.
 * Uses the T3 panel (bottom panel), NOT the sidebar quest todos view.
 * Focuses the T3 panel first (which triggers resolveWebviewView if needed),
 * then sends the selection message.
 * Returns true if the selection was sent successfully.
 */
export async function selectTodoInBottomPanel(todoId: string, file?: string, questId?: string): Promise<boolean> {
    const { getT3PanelProvider } = await import('./t3Panel-handler.js');
    const t3 = getT3PanelProvider();
    if (!t3) return false;

    // Focus the T3 panel first — this reveals it and triggers resolveWebviewView
    try {
        await vscode.commands.executeCommand('dartscript.wsPanel.focus');
    } catch {
        return false;
    }

    // If the view wasn't already resolved, wait briefly for resolveWebviewView to run
    if (!t3.isViewAvailable) {
        await new Promise<void>(resolve => setTimeout(resolve, 500));
    }

    if (t3.isViewAvailable) {
        t3.selectTodo(todoId, file, questId);
        return true;
    }

    return false;
}

// ============================================================================
// Embeddable content for T3 panel accordion
// ============================================================================

/** CSS styles for the Quest TODO section (embedded in accordion) */
export function getQuestTodoCss(): string {
    return `
/* ── Quest TODO ─────────────────────────────── */
.qt-top-bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
.qt-top-bar label { font-size: 11px; font-weight: 600; }
.qt-top-bar select { background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); color: var(--vscode-dropdown-foreground); border-radius: 3px; font-size: 12px; padding: 2px 4px; max-width: 160px; }
.qt-spacer { flex: 1; }
.qt-top-chat-group { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.qt-split { display: flex; flex: 1; overflow: hidden; min-height: 200px; }
.qt-list-pane { width: 38%; flex: 0 0 38%; min-width: 180px; overflow-y: auto; border-right: 1px solid var(--vscode-panel-border); }
.qt-splitter { width: 4px; cursor: col-resize; background: var(--vscode-panel-border); flex-shrink: 0; }
.qt-splitter:hover, .qt-splitter.dragging { background: var(--vscode-focusBorder); }
.qt-detail-pane { flex: 1; overflow-y: auto; padding: 8px; }
.qt-todo-item { padding: 6px 8px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.qt-todo-item-row1 { display: flex; align-items: center; gap: 6px; width: 100%; }
.qt-todo-item-row2 { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); padding-left: 22px; }
.qt-todo-item:hover { background: var(--vscode-list-hoverBackground); }
.qt-todo-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.qt-todo-item .status-icon { flex-shrink: 0; width: 16px; text-align: center; }
.qt-todo-item .qt-priority-dot { font-size: 10px; line-height: 1; margin-right: 4px; display: inline-flex; align-items: center; }
.qt-todo-item .qt-priority-dot.critical { color: var(--vscode-errorForeground); }
.qt-todo-item .qt-priority-dot.high { color: var(--vscode-editorWarning-foreground); }
.qt-todo-item .qt-priority-dot.medium { color: var(--vscode-testing-iconPassed); }
.qt-todo-item .qt-priority-dot.low { color: var(--vscode-descriptionForeground); }
.qt-todo-item .tid { font-weight: 600; flex-shrink: 0; }
.qt-todo-item .ttitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qt-todo-item .source-file { font-size: 10px; flex-shrink: 0; max-width: 100px; overflow: hidden; text-overflow: ellipsis; }
.qt-todo-item .priority-badge { font-size: 9px; padding: 1px 4px; border-radius: 3px; font-weight: 600; }
.qt-todo-item .priority-badge.critical { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
.qt-todo-item .priority-badge.high { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-inputValidation-warningForeground); }
.qt-todo-item.status-in-progress { border-left: 3px solid var(--vscode-editorInfo-foreground, #3794ff); }
.qt-todo-item.status-blocked { border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700); }
.qt-todo-item.status-completed { opacity: 0.6; }
.qt-todo-item.status-completed .ttitle { text-decoration: line-through; }
.qt-todo-item.status-cancelled { opacity: 0.5; font-style: italic; }
.qt-move-btn, .qt-move-ws-btn, .qt-restore-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 0 2px; font-size: 12px; opacity: 0.6; }
.qt-move-btn:hover, .qt-move-ws-btn:hover { opacity: 1; }
.qt-restore-btn:hover { opacity: 1; color: var(--vscode-testing-iconPassed); }
.qt-detail-form { display: flex; flex-direction: column; gap: 8px; }
.qt-form-row { display: flex; flex-direction: column; gap: 2px; }
.qt-form-row label { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); }
.qt-form-row input, .qt-form-row select, .qt-form-row textarea { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 3px; padding: 4px 6px; font-size: 12px; font-family: inherit; }
.qt-form-row textarea { resize: vertical; min-height: 60px; }
.qt-form-actions { display: flex; gap: 6px; padding-top: 8px; }
.qt-form-actions button { padding: 3px 8px; height: 22px; border-radius: 3px; cursor: pointer; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; font-family: inherit; }
.qt-form-actions button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border, transparent); }
.qt-form-actions button.primary:hover { background: var(--vscode-button-hoverBackground); }
.qt-form-actions button.qt-btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); padding: 3px 8px; height: 22px; }
.qt-form-actions button.qt-btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.qt-tag-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.qt-tag-chip { display: inline-flex; align-items: center; gap: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 6px; border-radius: 10px; font-size: 11px; }
.qt-tag-chip .qt-remove-tag { cursor: pointer; font-weight: bold; margin-left: 2px; }
.qt-tag-input { width: 80px; }
.qt-empty-detail { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--vscode-descriptionForeground); font-size: 12px; }
.qt-readonly { opacity: 0.6; }
.qt-top-bar button { padding: 3px 8px; height: 22px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; cursor: pointer; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
.qt-top-bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.qt-top-bar button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.qt-top-bar button.primary:hover { background: var(--vscode-button-hoverBackground); }
.qt-section-header { display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); padding: 4px 0; user-select: none; }
.qt-section-header:hover { color: var(--vscode-foreground); }
.qt-section-header .codicon { font-size: 12px; transition: transform 0.15s; }
.qt-section-header.collapsed .codicon { transform: rotate(-90deg); }
.qt-section-body { padding-left: 4px; }
.qt-section-body.hidden { display: none; }
.qt-inline-row { display: flex; gap: 6px; flex-wrap: wrap; }
.qt-inline-row .qt-form-row { flex: 1; min-width: 100px; }
.qt-ref-list { display: flex; flex-direction: column; gap: 4px; }
.qt-ref-item { display: flex; gap: 4px; align-items: flex-start; font-size: 11px; padding: 3px 6px; background: var(--vscode-textBlockQuote-background); border-radius: 3px; }
.qt-ref-item .qt-ref-text { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.qt-ref-item button { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 0 2px; font-size: 11px; opacity: 0.6; }
.qt-ref-item button:hover { opacity: 1; }
.qt-scope-summary { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 2px 0; }
.qt-popup-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.4); z-index: 1000; display: none; }
.qt-popup-overlay.visible { display: flex; align-items: center; justify-content: center; }
.qt-popup { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; min-width: 280px; max-width: 400px; max-height: 80vh; overflow-y: auto; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
.qt-popup h4 { margin: 0 0 8px; font-size: 12px; }
.qt-popup .qt-form-row { margin-bottom: 6px; }
.qt-popup-actions { display: flex; gap: 6px; margin-top: 10px; justify-content: flex-end; }
.qt-tag-picker-list { max-height: 200px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; margin: 6px 0; }
.qt-tag-picker-item { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 3px; cursor: pointer; font-size: 12px; }
.qt-tag-picker-item:hover { background: var(--vscode-list-hoverBackground); }
.qt-tag-picker-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.qt-edit-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 0 4px; font-size: 11px; opacity: 0.6; }
.qt-edit-btn:hover { opacity: 1; }
.qt-top-bar .qt-search-input { width: 80px; min-width: 60px; flex: 0 1 120px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 3px; padding: 3px 6px; font-size: 12px; }
.qt-top-bar .icon-btn.active-indicator { background: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; border-radius: 3px; }
.qt-top-bar .icon-btn.active-indicator:hover { background: var(--vscode-button-hoverBackground); }
/* ---- Picker overlays (filter/sort) ---- */
.qt-picker-overlay { position: absolute; left: 6px; top: 0; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); z-index: 200; padding: 4px 0; min-width: 200px; max-height: 350px; overflow-y: auto; }
.qt-picker-section-header { padding: 6px 10px 3px 10px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
.qt-picker-section-header:first-child { border-top: none; }
.qt-picker-option { padding: 4px 10px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 6px; }
.qt-picker-option:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
.qt-picker-option .qt-check-box { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.qt-picker-option .qt-check-box .codicon { font-size: 14px; }
.qt-picker-option .qt-sort-number { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; font-weight: 700; flex-shrink: 0; }
.qt-picker-option .qt-sort-number.empty { background: transparent; border: 1px solid var(--vscode-descriptionForeground); color: transparent; }
.qt-picker-footer { display: flex; justify-content: flex-end; gap: 4px; padding: 6px 10px 4px 10px; border-top: 1px solid var(--vscode-panel-border); margin-top: 2px; }
.qt-picker-footer button { padding: 3px 10px; font-size: 11px; border: none; border-radius: 3px; cursor: pointer; }
.qt-picker-footer button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.qt-picker-footer button.primary:hover { background: var(--vscode-button-hoverBackground); }
.qt-picker-footer button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.qt-picker-footer button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.qt-picker-date-row { display: flex; gap: 4px; padding: 4px 10px; align-items: center; }
.qt-picker-date-row label { font-size: 11px; min-width: 40px; }
.qt-picker-date-row input[type="date"] { flex: 1; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 3px; padding: 2px 4px; font-size: 11px; }
/* ---- Todo ID badges (for blocked-by / dependencies) ---- */
.qt-todo-badge { display: inline-flex; align-items: center; gap: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 6px; border-radius: 10px; font-size: 11px; cursor: pointer; }
.qt-todo-badge:hover { opacity: 0.85; }
.qt-todo-badge .qt-badge-remove { cursor: pointer; font-weight: bold; margin-left: 2px; font-size: 10px; }
.qt-todo-badge .qt-badge-remove:hover { color: var(--vscode-errorForeground); }
/* ---- File badges (for scope files) ---- */
.qt-file-badge { display: inline-flex; align-items: center; gap: 3px; background: var(--vscode-textBlockQuote-background); color: var(--vscode-foreground); padding: 2px 8px; border-radius: 10px; font-size: 11px; cursor: pointer; max-width: 220px; }
.qt-file-badge:hover { opacity: 0.85; }
.qt-file-badge .qt-file-badge-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qt-file-badge .qt-file-badge-ext { cursor: pointer; opacity: 0.6; font-size: 10px; }
.qt-file-badge .qt-file-badge-ext:hover { opacity: 1; }
.qt-file-badge .qt-file-badge-rm { cursor: pointer; font-weight: bold; font-size: 10px; }
.qt-file-badge .qt-file-badge-rm:hover { color: var(--vscode-errorForeground); }
/* ---- Mass Add overlay ---- */
.qt-mass-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1100; display: none; overflow-y: auto; }
.qt-mass-overlay.visible { display: flex; align-items: flex-start; justify-content: center; padding: 20px 10px; }
.qt-mass-panel { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 16px; width: 98%; max-width: 700px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
.qt-mass-panel h3 { margin: 0 0 12px; font-size: 14px; }
.qt-mass-row { display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; align-items: flex-start; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
.qt-mass-row .qt-mass-r1 { display: flex; gap: 6px; width: 100%; }
.qt-mass-row .qt-mass-r2 { width: 100%; }
.qt-mass-row input, .qt-mass-row select, .qt-mass-row textarea { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 3px; padding: 3px 6px; font-size: 12px; font-family: inherit; }
.qt-mass-row input[name="id"] { width: 130px; flex-shrink: 0; }
.qt-mass-row input[name="title"] { flex: 1; min-width: 100px; }
.qt-mass-row select[name="priority"] { width: 90px; flex-shrink: 0; }
.qt-mass-row textarea { resize: none; min-height: 24px; height: 24px; width: 100%; font-size: 11px; }
.qt-mass-row-num { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); min-width: 18px; line-height: 24px; }
.qt-mass-footer { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
.qt-mass-footer button { padding: 4px 14px; border-radius: 3px; cursor: pointer; font-size: 12px; border: none; }
.qt-mass-footer button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.qt-mass-footer button.primary:hover { background: var(--vscode-button-hoverBackground); }
.qt-mass-footer button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
/* ---- Trash/Reopen buttons ---- */
.qt-trash-btn, .qt-reopen-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 0 2px; font-size: 12px; opacity: 0.6; }
.qt-trash-btn:hover { opacity: 1; color: var(--vscode-errorForeground); }
.qt-reopen-btn:hover { opacity: 1; color: var(--vscode-testing-iconPassed); }
`;
}

/** HTML fragment for the Quest TODO section content (inside accordion) */
export function getQuestTodoHtmlFragment(_config?: QuestTodoViewConfig): string {
    return `
<div class="qt-top-bar">
    <label>Quest:</label>
    <select id="qt-quest-select"></select>
    <label>File:</label>
    <select id="qt-file-select"><option value="all">All files</option></select>
    <span id="qt-fixed-file-label" class="qt-scope-summary" style="display:none;"></span>
    <input id="qt-search" type="text" placeholder="Search..." class="qt-search-input">
    <button class="icon-btn" id="qt-btn-filter" title="Filter"><span class="codicon codicon-filter"></span></button>
    <button class="icon-btn" id="qt-btn-sort" title="Sort"><span class="codicon codicon-list-ordered"></span></button>
    <button class="icon-btn" id="qt-btn-nav-back" title="Back" disabled style="opacity:0.3"><span class="codicon codicon-arrow-left"></span></button>
    <button class="icon-btn" id="qt-btn-nav-fwd" title="Forward" disabled style="opacity:0.3"><span class="codicon codicon-arrow-right"></span></button>
    <button class="icon-btn" id="qt-btn-reload" title="Reload from disk"><span class="codicon codicon-refresh"></span></button>
    <button class="icon-btn" id="qt-btn-open-yaml" title="Open YAML"><span class="codicon codicon-go-to-file"></span></button>
    <button class="icon-btn" id="qt-btn-toggle-backup" title="Switch to backup file" style="display:none"><span class="codicon codicon-archive"></span></button>
    <button class="icon-btn" id="qt-btn-open-ext" title="Open in external application" style="display:none"><span class="codicon codicon-terminal"></span></button>
    <button class="icon-btn" id="qt-btn-import" title="Import todos from file" style="display:none"><span class="codicon codicon-cloud-download"></span></button>
    <button class="icon-btn" id="qt-btn-popout" title="Open in editor area"><span class="codicon codicon-link-external"></span></button>
    <button class="primary" id="qt-btn-add-todo" title="Add Todo"><span class="codicon codicon-add"></span> Add</button>
    <button class="icon-btn" id="qt-btn-mass-add" title="Mass Add Todos"><span class="codicon codicon-list-unordered"></span></button>
    <span class="qt-spacer"></span>
    <div class="qt-top-chat-group">
        <label>Template:</label>
        <select id="qt-template-select"><option value="__none__">(None)</option></select>
        <button class="icon-btn" id="qt-btn-add-queue" title="Save to Queue"><span class="codicon codicon-add"></span><span class="codicon codicon-list-ordered"></span></button>
        <button class="icon-btn primary" id="qt-btn-send-copilot" title="Send to Copilot"><span class="codicon codicon-send"></span></button>
        <button class="icon-btn" id="qt-btn-open-trail" title="Open Trail"><span class="codicon codicon-history"></span></button>
    </div>
</div>
<div class="qt-split" style="position:relative;">
    <div class="qt-list-pane" id="qt-list-pane"></div>
    <div class="qt-splitter" id="qt-splitter" title="Drag to resize"></div>
    <div class="qt-detail-pane" id="qt-detail-pane"><div class="qt-empty-detail">Select a todo to view details</div></div>
    <div id="qt-filter-picker" class="qt-picker-overlay" style="display:none;"></div>
    <div id="qt-sort-picker" class="qt-picker-overlay qt-sort-picker-overlay" style="display:none;"></div>
</div>
<div class="qt-popup-overlay" id="qt-popup-overlay">
    <div class="qt-popup" id="qt-popup-content"></div>
</div>
<div class="qt-mass-overlay" id="qt-mass-overlay">
    <div class="qt-mass-panel" id="qt-mass-panel"></div>
</div>`;
}

/** Client-side JavaScript for the Quest TODO section */
export function getQuestTodoScript(config?: QuestTodoViewConfig): string {
    const cfgJson = JSON.stringify(config ?? {});
    return `
// ── Quest TODO variables ──
var qtViewConfig = ${cfgJson};
var qtCurrentQuestId = '';
var qtCurrentFile = 'all';
var qtSelectedTodoId = '';
var qtTodos = [];
var qtDetailTodo = null;
var qtFormScope = null;
var qtFormRefs = [];
var qtFormTags = [];
var qtTagPickerCallback = null;
var qtFilterSearch = '';
var qtFilterState = { status: [], priority: [], tags: [], createdFrom: '', createdTo: '', updatedFrom: '', updatedTo: '', completedFrom: '', completedTo: '' };
var qtSortFields = []; // [{field,asc}]
var SORTABLE_FIELDS = ['status','priority','title','created','updated','completed_date'];
var qtUserName = '';
var qtNavHistory = [];
var qtNavIndex = -1;
var qtNavPushing = true;
var qtAutoSaveTimer = null;
var qtAllTodosForPicker = [];
var qtTagPickerScope = 'all';
var qtPathExtAppAvailability = {};
var qtPendingStatusChange = null;
var qtCurrentTemplate = '__none__';
var qtViewingBackup = false;
var qtPendingSelectTodoId = '';

function qtPersistState() {
    vscode.postMessage({ type: 'qtSaveState', state: {
        questId: qtCurrentQuestId,
        file: qtCurrentFile,
        tagScope: qtTagPickerScope,
        sortFields: qtSortFields,
        filterState: qtFilterState
    }});
}

function qtNavPush(todoId) {
    if (!qtNavPushing) return;
    qtNavHistory = qtNavHistory.slice(0, qtNavIndex + 1);
    qtNavHistory.push(todoId);
    qtNavIndex = qtNavHistory.length - 1;
    var navBack = document.getElementById('qt-btn-nav-back');
    var navFwd = document.getElementById('qt-btn-nav-fwd');
    if (navBack) { navBack.disabled = qtNavIndex <= 0; navBack.style.opacity = qtNavIndex <= 0 ? '0.3' : '1'; }
    if (navFwd) { navFwd.disabled = true; navFwd.style.opacity = '0.3'; }
}

(function initQuestTodoSection() {
    var questSel = document.getElementById('qt-quest-select');
    var fileSel = document.getElementById('qt-file-select');
    var openBtn = document.getElementById('qt-btn-open-yaml');
    var addBtn = document.getElementById('qt-btn-add-todo');
    var questLabel = questSel ? questSel.previousElementSibling : null;
    var fileLabel = fileSel ? fileSel.previousElementSibling : null;
    var fixedFileLabel = document.getElementById('qt-fixed-file-label');
    var navBack = document.getElementById('qt-btn-nav-back');
    var navFwd = document.getElementById('qt-btn-nav-fwd');
    if (!questSel) return; // section not rendered yet

    function qtNavUpdateButtons() {
        if (navBack) { navBack.disabled = qtNavIndex <= 0; navBack.style.opacity = qtNavIndex <= 0 ? '0.3' : '1'; }
        if (navFwd) { navFwd.disabled = qtNavIndex >= qtNavHistory.length - 1; navFwd.style.opacity = qtNavIndex >= qtNavHistory.length - 1 ? '0.3' : '1'; }
    }
    function qtNavGo(todoId) {
        qtNavPushing = false;
        qtSelectedTodoId = todoId;
        qtRenderList();
        vscode.postMessage({ type: 'qtGetTodo', questId: qtCurrentQuestId, todoId: todoId });
        qtNavPushing = true;
        qtNavUpdateButtons();
    }
    if (navBack) navBack.addEventListener('click', function() {
        if (qtNavIndex > 0) { qtNavIndex--; qtNavGo(qtNavHistory[qtNavIndex]); }
    });
    if (navFwd) navFwd.addEventListener('click', function() {
        if (qtNavIndex < qtNavHistory.length - 1) { qtNavIndex++; qtNavGo(qtNavHistory[qtNavIndex]); }
    });

    if (qtViewConfig.hideQuestSelect && questSel) {
        questSel.style.display = 'none';
        if (questLabel) { questLabel.style.display = 'none'; }
    }
    if (qtViewConfig.hideFileSelect && fileSel) {
        fileSel.style.display = 'none';
        if (fileLabel) { fileLabel.style.display = 'none'; }
    }
    if (qtViewConfig.fixedFileLabel && fixedFileLabel) {
        fixedFileLabel.textContent = qtViewConfig.fixedFileLabel;
        fixedFileLabel.style.display = '';
    }
    if (qtViewConfig.disableFileActions) {
        if (openBtn) {
            openBtn.disabled = true;
            openBtn.style.opacity = '0.3';
        }
        var popoutBtn0 = document.getElementById('qt-btn-popout');
        if (popoutBtn0) {
            popoutBtn0.style.display = 'none';
        }
    }

    questSel.addEventListener('change', function() {
        qtCurrentQuestId = this.value;
        qtCurrentFile = 'all';
        fileSel.value = 'all';
        var isSpecial = qtCurrentQuestId === '__all_quests__' || qtCurrentQuestId === '__all_workspace__';
        addBtn.disabled = isSpecial;
        addBtn.style.opacity = isSpecial ? '0.4' : '1';
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: 'all' });
        qtPersistState();
    });
    fileSel.addEventListener('change', function() {
        qtCurrentFile = this.value;
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
        qtPersistState();
    });
    openBtn.addEventListener('click', function() {
        if (qtCurrentQuestId) {
            vscode.postMessage({ type: 'qtOpenYaml', questId: qtCurrentQuestId, file: qtCurrentFile || 'all' });
        }
    });
    var popoutBtn = document.getElementById('qt-btn-popout');
    if (popoutBtn) popoutBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'qtPopout' });
    });
    addBtn.addEventListener('click', function() {
        var isSession = qtViewConfig && qtViewConfig.mode === 'session';
        var isWorkspaceFile = qtViewConfig && qtViewConfig.mode === 'workspace-file';
        if (!isSession && !isWorkspaceFile && qtCurrentFile === 'all') return;
        if (qtCurrentQuestId === '__all_quests__' || qtCurrentQuestId === '__all_workspace__') return;
        var id = 'todo-' + Date.now().toString(36);
        qtShowNewTodoForm(id);
    });
    // Mass Add button
    var massAddBtn = document.getElementById('qt-btn-mass-add');
    if (massAddBtn) massAddBtn.addEventListener('click', function() {
        var isSession = qtViewConfig && qtViewConfig.mode === 'session';
        var isWorkspaceFile = qtViewConfig && qtViewConfig.mode === 'workspace-file';
        if (!isSession && !isWorkspaceFile && qtCurrentFile === 'all') return;
        if (qtCurrentQuestId === '__all_quests__' || qtCurrentQuestId === '__all_workspace__') return;
        qtShowMassAddOverlay();
    });
    // Filter/sort bar — new icon buttons with picker overlays
    var searchInput = document.getElementById('qt-search');
    var btnFilter = document.getElementById('qt-btn-filter');
    var btnSort = document.getElementById('qt-btn-sort');
    var btnReload = document.getElementById('qt-btn-reload');
    var btnOpenExt = document.getElementById('qt-btn-open-ext');
    var btnOpenTrail = document.getElementById('qt-btn-open-trail');
    var templateSelect = document.getElementById('qt-template-select');
    var addQueueBtn = document.getElementById('qt-btn-add-queue');
    var sendCopilotBtn = document.getElementById('qt-btn-send-copilot');
    if (searchInput) searchInput.addEventListener('input', function() { qtFilterSearch = this.value.toLowerCase(); qtRenderList(); });
    if (btnFilter) btnFilter.addEventListener('click', function(e) { e.stopPropagation(); qtToggleFilterPicker(); });
    if (btnSort) btnSort.addEventListener('click', function(e) { e.stopPropagation(); qtToggleSortPicker(); });
    if (btnReload) btnReload.addEventListener('click', function() {
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
    });
    if (btnOpenExt) btnOpenExt.addEventListener('click', function() {
        vscode.postMessage({ type: 'qtOpenExtApp', questId: qtCurrentQuestId, file: qtCurrentFile });
    });
    if (btnOpenTrail) btnOpenTrail.addEventListener('click', function() {
        vscode.postMessage({ type: 'qtOpenTrailFiles' });
    });
    // Import button — show in all modes
    var btnImport = document.getElementById('qt-btn-import');
    if (btnImport) {
        btnImport.style.display = '';
        btnImport.addEventListener('click', function() {
            vscode.postMessage({ type: 'qtImportFromFile', questId: qtCurrentQuestId, file: qtCurrentFile });
        });
    }
    // Backup toggle button
    var btnToggleBackup = document.getElementById('qt-btn-toggle-backup');
    if (btnToggleBackup) {
        btnToggleBackup.addEventListener('click', function() {
            qtViewingBackup = !qtViewingBackup;
            if (qtViewingBackup) {
                btnToggleBackup.classList.add('active-indicator');
                btnToggleBackup.title = 'Switch to normal file';
                vscode.postMessage({ type: 'qtGetBackupTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
            } else {
                btnToggleBackup.classList.remove('active-indicator');
                btnToggleBackup.title = 'Switch to backup file';
                vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
            }
        });
    }
    if (templateSelect) templateSelect.addEventListener('change', function() {
        qtCurrentTemplate = this.value || '__none__';
    });
    if (addQueueBtn) addQueueBtn.addEventListener('click', function() {
        if (!qtSelectedTodoId) {
            vscode.postMessage({ type: 'qtShowError', message: 'Select a todo first.' });
            return;
        }
        vscode.postMessage({
            type: 'qtAddCurrentTodoToQueue',
            questId: qtCurrentQuestId,
            file: qtCurrentFile,
            todoId: qtSelectedTodoId,
            sourceFile: qtDetailTodo && qtDetailTodo._sourceFile ? qtDetailTodo._sourceFile : undefined,
            template: qtCurrentTemplate,
        });
    });
    if (sendCopilotBtn) sendCopilotBtn.addEventListener('click', function() {
        if (!qtSelectedTodoId) {
            vscode.postMessage({ type: 'qtShowError', message: 'Select a todo first.' });
            return;
        }
        vscode.postMessage({
            type: 'qtSendCurrentTodoToCopilot',
            questId: qtCurrentQuestId,
            file: qtCurrentFile,
            todoId: qtSelectedTodoId,
            sourceFile: qtDetailTodo && qtDetailTodo._sourceFile ? qtDetailTodo._sourceFile : undefined,
            template: qtCurrentTemplate,
        });
    });
    // Close pickers on outside click
    document.addEventListener('click', function(e) {
        var fp = document.getElementById('qt-filter-picker');
        var sp = document.getElementById('qt-sort-picker');
        if (fp && fp.style.display !== 'none' && !fp.contains(e.target) && e.target !== btnFilter && !btnFilter.contains(e.target)) fp.style.display = 'none';
        if (sp && sp.style.display !== 'none' && !sp.contains(e.target) && e.target !== btnSort && !btnSort.contains(e.target)) sp.style.display = 'none';
    });

    // Draggable split between todo list and detail panel
    (function initQtSplitDrag() {
        var split = document.querySelector('.qt-split');
        var listPane = document.getElementById('qt-list-pane');
        var splitter = document.getElementById('qt-splitter');
        if (!split || !listPane || !splitter) return;
        var dragging = false;
        splitter.addEventListener('mousedown', function(e) {
            dragging = true;
            splitter.classList.add('dragging');
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!dragging) return;
            var rect = split.getBoundingClientRect();
            var left = e.clientX - rect.left;
            var pct = (left / rect.width) * 100;
            pct = Math.max(20, Math.min(70, pct));
            listPane.style.width = pct + '%';
            listPane.style.flex = '0 0 ' + pct + '%';
        });
        document.addEventListener('mouseup', function() {
            if (!dragging) return;
            dragging = false;
            splitter.classList.remove('dragging');
        });
    })();
    // Request username from config
    vscode.postMessage({ type: 'qtGetUserName' });
    vscode.postMessage({ type: 'qtGetTemplates' });
    vscode.postMessage({ type: 'qtGetPendingSelect' });
    // Send config + request initial data
    vscode.postMessage({ type: 'qtInitConfig', config: qtViewConfig });
    if (qtViewConfig.mode === 'session') {
        qtCurrentQuestId = '__session__';
        qtCurrentFile = 'all';
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
        vscode.postMessage({ type: 'qtCheckBackupExists', questId: qtCurrentQuestId, file: qtCurrentFile });
    } else if (qtViewConfig.mode === 'workspace-file') {
        qtCurrentQuestId = '__all_workspace__';
        qtCurrentFile = 'all';
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
        vscode.postMessage({ type: 'qtCheckBackupExists', questId: qtCurrentQuestId, file: qtCurrentFile });
    } else if (qtViewConfig.fixedQuestId) {
        qtCurrentQuestId = qtViewConfig.fixedQuestId;
        qtCurrentFile = qtViewConfig.fixedFile || 'all';
        vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
        vscode.postMessage({ type: 'qtGetFiles', questId: qtCurrentQuestId });
        vscode.postMessage({ type: 'qtCheckBackupExists', questId: qtCurrentQuestId, file: qtCurrentFile });
    } else {
        vscode.postMessage({ type: 'qtGetQuests' });
        vscode.postMessage({ type: 'qtCheckBackupExists', questId: '', file: 'all' });
    }
})();

function qtRenderList() {
    var pane = document.getElementById('qt-list-pane');
    if (!pane) return;
    if (!qtTodos.length) { pane.innerHTML = '<div class="qt-empty-detail">No todos found</div>'; return; }

    // Apply filters
    var filtered = qtTodos.filter(function(t) {
        if (qtFilterState.status.length && qtFilterState.status.indexOf(t.status || 'not-started') === -1) return false;
        if (qtFilterState.priority.length && qtFilterState.priority.indexOf(t.priority || '') === -1) return false;
        if (qtFilterState.tags.length) {
            var tTags = t.tags || [];
            var hasTag = false;
            for (var ti = 0; ti < qtFilterState.tags.length; ti++) { if (tTags.indexOf(qtFilterState.tags[ti]) >= 0) { hasTag = true; break; } }
            if (!hasTag) return false;
        }
        if (qtFilterState.createdFrom && (t.created || '') < qtFilterState.createdFrom) return false;
        if (qtFilterState.createdTo && (t.created || '') > qtFilterState.createdTo) return false;
        if (qtFilterState.updatedFrom && (t.updated || '') < qtFilterState.updatedFrom) return false;
        if (qtFilterState.updatedTo && (t.updated || '') > qtFilterState.updatedTo) return false;
        if (qtFilterSearch) {
            var hay = ((t.id || '') + ' ' + (t.title || '') + ' ' + (t.sourceFile || '')).toLowerCase();
            if (hay.indexOf(qtFilterSearch) === -1) return false;
        }
        return true;
    });

    // Apply multi-field sort
    if (qtSortFields.length) {
        var priOrd = { critical: 0, high: 1, medium: 2, low: 3 };
        var staOrd = { 'in-progress': 0, 'blocked': 1, 'not-started': 2, 'completed': 3, 'cancelled': 4 };
        filtered = filtered.slice().sort(function(a, b) {
            for (var si = 0; si < qtSortFields.length; si++) {
                var sf = qtSortFields[si];
                var cmp = 0;
                switch (sf.field) {
                    case 'status': cmp = (staOrd[a.status] || 9) - (staOrd[b.status] || 9); break;
                    case 'priority': cmp = (priOrd[a.priority] || 9) - (priOrd[b.priority] || 9); break;
                    case 'title': cmp = (a.title || '').localeCompare(b.title || ''); break;
                    case 'created': cmp = (a.created || '').localeCompare(b.created || ''); break;
                    case 'updated': cmp = (b.updated || '').localeCompare(a.updated || ''); break;
                    case 'completed_date': cmp = (a.completed_date || '').localeCompare(b.completed_date || ''); break;
                }
                if (!sf.asc) cmp = -cmp;
                if (cmp !== 0) return cmp;
            }
            return 0;
        });
    }

    if (!filtered.length) { pane.innerHTML = '<div class="qt-empty-detail">No matching todos</div>'; return; }

    pane.innerHTML = filtered.map(function(t) {
        var icon = qtStatusIcon(t.status);
        var cls = 'qt-todo-item status-' + (t.status || 'not-started');
        if (t.id === qtSelectedTodoId) cls += ' selected';
        var showSrc = (qtCurrentFile === 'all' || qtCurrentQuestId === '__all_quests__' || qtCurrentQuestId === '__all_workspace__') && t.sourceFile;
        var srcLabel = showSrc ? '<span class="source-file">' + qtEsc(t.sourceFile) + '</span>' : '';
        var isSpecialMode = qtCurrentQuestId === '__all_quests__' || qtCurrentQuestId === '__all_workspace__';
        var isQuestMode = !isSpecialMode && qtCurrentQuestId;
        var isDone = t.status === 'completed' || t.status === 'cancelled';
        var moveBtn = '';
        var moveWsBtn = '';
        var trashBtn = '';
        var reopenBtn = '';
        var restoreBtn = '';
        if (qtViewingBackup) {
            // Backup mode: completed/cancelled -> reopen + delete; reopened -> move back to file
            if (isDone) {
                reopenBtn = '<button class="qt-reopen-btn" data-qt-reopen="' + qtEsc(t.id) + '" title="Reopen (set to not-started)">🔄</button>';
                trashBtn = '<button class="qt-trash-btn" data-qt-trash="' + qtEsc(t.id) + '" title="Permanently delete">🗑️</button>';
            } else {
                restoreBtn = '<button class="qt-restore-btn" data-qt-restore="' + qtEsc(t.id) + '" title="Move back to todo file">↩️</button>';
                trashBtn = '<button class="qt-trash-btn" data-qt-trash="' + qtEsc(t.id) + '" title="Permanently delete">🗑️</button>';
            }
        } else if (isDone) {
            trashBtn = '<button class="qt-trash-btn" data-qt-trash="' + qtEsc(t.id) + '" title="Delete (move to backup)">🗑️</button>';
            reopenBtn = '<button class="qt-reopen-btn" data-qt-reopen="' + qtEsc(t.id) + '" title="Reopen (set to not-started)">🔄</button>';
        } else {
            moveBtn = isQuestMode && qtCurrentFile === 'all' ? '<button class="qt-move-btn" data-qt-move="' + qtEsc(t.id) + '" title="Move to main quest todo file">➡️</button>' : '';
            moveWsBtn = '<button class="qt-move-ws-btn" data-qt-movews="' + qtEsc(t.id) + '" title="Move to workspace todos">⬆️</button>';
        }
        var priorityBadge = t.priority && (t.priority === 'critical' || t.priority === 'high') ? '<span class="priority-badge ' + t.priority + '">' + t.priority.toUpperCase() + '</span>' : '';
        var priorityDot = t.priority ? '<span class="qt-priority-dot ' + qtEsc(t.priority) + '">●</span>' : '';
        return '<div class="' + cls + '" data-qt-id="' + qtEsc(t.id) + '">' +
            '<div class="qt-todo-item-row1">' +
            '<span class="status-icon">' + icon + '</span>' +
            '<span class="ttitle">' + qtEsc(t.title || '') + '</span>' +
            priorityBadge + moveBtn + moveWsBtn + restoreBtn + trashBtn + reopenBtn + '</div>' +
            '<div class="qt-todo-item-row2">' +
            priorityDot +
            '<span class="tid">' + qtEsc(t.id) + '</span>' +
            srcLabel + '</div></div>';
    }).join('');

    pane.querySelectorAll('.qt-todo-item').forEach(function(el) {
        el.addEventListener('click', function(e) {
            if (e.target.closest('.qt-move-btn') || e.target.closest('.qt-move-ws-btn') || e.target.closest('.qt-trash-btn') || e.target.closest('.qt-reopen-btn') || e.target.closest('.qt-restore-btn')) return;
            qtSelectedTodoId = el.dataset.qtId;
            qtNavPush(qtSelectedTodoId);
            qtRenderList();
            vscode.postMessage({ type: 'qtGetTodo', questId: qtCurrentQuestId, todoId: qtSelectedTodoId, fromBackup: qtViewingBackup });
        });
    });
    pane.querySelectorAll('.qt-move-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtMove;
            var mainFile = 'todos.' + qtCurrentQuestId + '.todo.yaml';
            vscode.postMessage({ type: 'qtMoveTodo', questId: qtCurrentQuestId, todoId: tid, targetFile: mainFile });
        });
    });
    pane.querySelectorAll('.qt-move-ws-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtMovews;
            vscode.postMessage({ type: 'qtMoveToWorkspace', questId: qtCurrentQuestId, todoId: tid });
        });
    });
    pane.querySelectorAll('.qt-trash-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtTrash;
            var srcFile = '';
            var match = qtTodos.filter(function(t) { return t.id === tid; });
            if (match.length) srcFile = match[0].sourceFile || '';
            vscode.postMessage({ type: 'qtDeleteTodo', questId: qtCurrentQuestId, todoId: tid, sourceFile: srcFile, fromBackup: qtViewingBackup });
        });
    });
    pane.querySelectorAll('.qt-reopen-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtReopen;
            vscode.postMessage({ type: 'qtReopenTodo', questId: qtCurrentQuestId, todoId: tid, fromBackup: qtViewingBackup });
        });
    });
    pane.querySelectorAll('.qt-restore-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = btn.dataset.qtRestore;
            vscode.postMessage({ type: 'qtRestoreFromBackup', questId: qtCurrentQuestId, todoId: tid, file: qtCurrentFile });
        });
    });
}

function qtStatusIcon(s) {
    switch(s) {
        case 'in-progress': return '🔄';
        case 'completed': return '✅';
        case 'blocked': return '⛔';
        case 'cancelled': return '🚫';
        default: return '⬜';
    }
}

// ── Filter picker ──
function qtToggleFilterPicker() {
    var el = document.getElementById('qt-filter-picker');
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    document.getElementById('qt-sort-picker').style.display = 'none';
    qtRenderFilterPicker();
    el.style.display = '';
}

function qtHasActiveFilters() {
    return qtFilterState.status.length > 0 || qtFilterState.priority.length > 0 || qtFilterState.tags.length > 0 ||
        qtFilterState.createdFrom || qtFilterState.createdTo || qtFilterState.updatedFrom || qtFilterState.updatedTo;
}

function qtUpdateFilterIndicator() {
    var btn = document.getElementById('qt-btn-filter');
    if (!btn) return;
    if (qtHasActiveFilters()) btn.classList.add('active-indicator');
    else btn.classList.remove('active-indicator');
}

function qtRenderFilterPicker() {
    var el = document.getElementById('qt-filter-picker');
    if (!el) return;
    var statuses = ['not-started','in-progress','blocked','completed','cancelled'];
    var priorities = ['critical','high','medium','low'];
    // Collect all tags from current todos
    var allTags = [];
    var tagSet = {};
    qtTodos.forEach(function(t) { (t.tags || []).forEach(function(tag) { if (!tagSet[tag]) { tagSet[tag] = true; allTags.push(tag); } }); });
    allTags.sort();

    var html = '<div class="qt-picker-section-header">Status</div>';
    statuses.forEach(function(s) {
        var checked = qtFilterState.status.indexOf(s) >= 0;
        html += '<div class="qt-picker-option" data-qt-filter-type="status" data-qt-filter-val="' + s + '">' +
            '<span class="qt-check-box"><span class="codicon ' + (checked ? 'codicon-check' : '') + '"></span></span> ' + s + '</div>';
    });
    html += '<div class="qt-picker-section-header">Priority</div>';
    priorities.forEach(function(p) {
        var checked = qtFilterState.priority.indexOf(p) >= 0;
        html += '<div class="qt-picker-option" data-qt-filter-type="priority" data-qt-filter-val="' + p + '">' +
            '<span class="qt-check-box"><span class="codicon ' + (checked ? 'codicon-check' : '') + '"></span></span> ' + p + '</div>';
    });
    if (allTags.length) {
        html += '<div class="qt-picker-section-header">Tags</div>';
        allTags.forEach(function(tag) {
            var checked = qtFilterState.tags.indexOf(tag) >= 0;
            html += '<div class="qt-picker-option" data-qt-filter-type="tags" data-qt-filter-val="' + qtEsc(tag) + '">' +
                '<span class="qt-check-box"><span class="codicon ' + (checked ? 'codicon-check' : '') + '"></span></span> ' + qtEsc(tag) + '</div>';
        });
    }
    html += '<div class="qt-picker-section-header">Date Ranges</div>';
    html += '<div class="qt-picker-date-row"><label>Created</label><input type="date" id="qt-fp-created-from" value="' + (qtFilterState.createdFrom || '') + '"><span>–</span><input type="date" id="qt-fp-created-to" value="' + (qtFilterState.createdTo || '') + '"></div>';
    html += '<div class="qt-picker-date-row"><label>Updated</label><input type="date" id="qt-fp-updated-from" value="' + (qtFilterState.updatedFrom || '') + '"><span>–</span><input type="date" id="qt-fp-updated-to" value="' + (qtFilterState.updatedTo || '') + '"></div>';
    html += '<div class="qt-picker-footer"><button class="secondary" id="qt-fp-reset">Reset</button><button class="primary" id="qt-fp-ok">OK</button></div>';
    el.innerHTML = html;

    // Attach click handlers for checkboxes (inline toggle)
    el.querySelectorAll('.qt-picker-option').forEach(function(opt) {
        opt.addEventListener('click', function() {
            var type = opt.dataset.qtFilterType;
            var val = opt.dataset.qtFilterVal;
            var arr = qtFilterState[type];
            var idx = arr.indexOf(val);
            if (idx >= 0) arr.splice(idx, 1); else arr.push(val);
            var icon = opt.querySelector('.qt-check-box .codicon');
            if (icon) { icon.className = 'codicon ' + (arr.indexOf(val) >= 0 ? 'codicon-check' : ''); }
        });
    });
    // Date range inputs
    var cfEl = document.getElementById('qt-fp-created-from');
    var ctEl = document.getElementById('qt-fp-created-to');
    var ufEl = document.getElementById('qt-fp-updated-from');
    var utEl = document.getElementById('qt-fp-updated-to');
    if (cfEl) cfEl.addEventListener('change', function() { qtFilterState.createdFrom = this.value; });
    if (ctEl) ctEl.addEventListener('change', function() { qtFilterState.createdTo = this.value; });
    if (ufEl) ufEl.addEventListener('change', function() { qtFilterState.updatedFrom = this.value; });
    if (utEl) utEl.addEventListener('change', function() { qtFilterState.updatedTo = this.value; });
    // Reset
    document.getElementById('qt-fp-reset').addEventListener('click', function() {
        qtFilterState = { status: [], priority: [], tags: [], createdFrom: '', createdTo: '', updatedFrom: '', updatedTo: '', completedFrom: '', completedTo: '' };
        qtRenderFilterPicker();
        qtUpdateFilterIndicator();
        qtRenderList();
        qtPersistState();
    });
    // OK
    document.getElementById('qt-fp-ok').addEventListener('click', function() {
        el.style.display = 'none';
        qtUpdateFilterIndicator();
        qtRenderList();
        qtPersistState();
    });
}

// ── Sort picker ──
function qtToggleSortPicker() {
    var el = document.getElementById('qt-sort-picker');
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    document.getElementById('qt-filter-picker').style.display = 'none';
    qtRenderSortPicker();
    el.style.display = '';
}

function qtRenderSortPicker() {
    var el = document.getElementById('qt-sort-picker');
    if (!el) return;
    var pending = qtSortFields.slice(); // copy for editing
    var html = '<div class="qt-picker-section-header">Sort Fields</div>';
    SORTABLE_FIELDS.forEach(function(field) {
        var idx = -1; var asc = true;
        for (var i = 0; i < pending.length; i++) { if (pending[i].field === field) { idx = i; asc = pending[i].asc; break; } }
        var numCls = idx >= 0 ? 'qt-sort-number' : 'qt-sort-number empty';
        var numLabel = idx >= 0 ? String(idx + 1) : '';
        var dirIcon = asc ? '↑' : '↓';
        html += '<div class="qt-picker-option" data-qt-sort-field="' + field + '">' +
            '<span class="' + numCls + '">' + numLabel + '</span> ' +
            field + ' <span class="qt-sort-dir" style="margin-left:auto;cursor:pointer;">' + (idx >= 0 ? dirIcon : '') + '</span></div>';
    });
    html += '<div class="qt-picker-footer"><button class="secondary" id="qt-sp-reset">Reset</button><button class="primary" id="qt-sp-ok">OK</button></div>';
    el.innerHTML = html;

    el.querySelectorAll('.qt-picker-option').forEach(function(opt) {
        opt.addEventListener('click', function(e) {
            e.stopPropagation();
            var field = opt.dataset.qtSortField;
            var existing = -1;
            for (var i = 0; i < pending.length; i++) { if (pending[i].field === field) { existing = i; break; } }
            if (e.target.closest('.qt-sort-dir') && existing >= 0) {
                pending[existing].asc = !pending[existing].asc;
            } else if (existing >= 0) {
                pending.splice(existing, 1);
            } else {
                pending.push({ field: field, asc: true });
            }
            qtSortFields = pending;
            qtRenderSortPicker();
        });
    });
    document.getElementById('qt-sp-reset').addEventListener('click', function(e) {
        e.stopPropagation();
        qtSortFields = []; pending = [];
        var sortBtn = document.getElementById('qt-btn-sort');
        if (sortBtn) sortBtn.classList.remove('active-indicator');
        qtRenderSortPicker();
        qtRenderList();
        qtPersistState();
    });
    document.getElementById('qt-sp-ok').addEventListener('click', function(e) {
        e.stopPropagation();
        qtSortFields = pending;
        el.style.display = 'none';
        var sortBtn = document.getElementById('qt-btn-sort');
        if (sortBtn) { if (qtSortFields.length) sortBtn.classList.add('active-indicator'); else sortBtn.classList.remove('active-indicator'); }
        qtRenderList();
        qtPersistState();
    });
}

// ── Autosave helper ──
function qtAutoSave() {
    if (qtAutoSaveTimer) clearTimeout(qtAutoSaveTimer);
    qtAutoSaveTimer = setTimeout(function() {
        if (!qtDetailTodo) return;
        var updates = qtCollectFormData();
        var saveQuestId = (qtDetailTodo._resolvedQuestId) || qtCurrentQuestId;
        vscode.postMessage({ type: 'qtSaveTodo', questId: saveQuestId, todoId: qtDetailTodo.id, updates: updates });
    }, 600);
}

function qtRenderDetail(todo) {
    qtDetailTodo = todo;
    var pane = document.getElementById('qt-detail-pane');
    if (!pane) return;
    if (!todo) { pane.innerHTML = '<div class="qt-empty-detail">Select a todo to view details</div>'; return; }

    qtFormTags = (todo.tags || []).slice();
    qtFormScope = todo.scope ? JSON.parse(JSON.stringify(todo.scope)) : null;
    qtFormRefs = todo.references ? JSON.parse(JSON.stringify(todo.references)) : [];

    var blockedByBadges = qtRenderTodoBadges(todo.blocked_by || [], 'blocked-by');
    var depsBadges = qtRenderTodoBadges(todo.dependencies || [], 'deps');

    pane.innerHTML = '<div class="qt-detail-form">' +
        qtFormRow('ID', '<input id="qt-d-id" value="' + qtEsc(todo.id) + '" readonly class="qt-readonly">') +
        qtFormRow('Title', '<input id="qt-d-title" value="' + qtEsc(todo.title || '') + '">') +
        qtFormRow('Description', '<textarea id="qt-d-desc">' + qtEsc(todo.description || '') + '</textarea>') +
        '<div class="qt-inline-row">' +
        qtFormRow('Status', '<select id="qt-d-status">' + qtStatusOptions(todo.status) + '</select>') +
        qtFormRow('Priority', '<select id="qt-d-priority">' + qtPriorityOptions(todo.priority) + '</select>') +
        '</div>' +
        qtFormRow('Tags', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">' +
            '<div class="qt-tag-chips" id="qt-d-tags">' + qtRenderTagChipsHtml(qtFormTags) + '</div>' +
            '<input class="qt-tag-input" id="qt-d-tag-input" placeholder="Add tag...">' +
            '<button class="qt-edit-btn" id="qt-d-tag-picker-btn" title="Pick from existing tags">🏷️</button></div>') +
        qtFormRow('Dependencies', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;" id="qt-d-deps-wrap">' + depsBadges +
            '<button class="qt-edit-btn" id="qt-d-deps-add" title="Add dependency">➕</button></div>') +
        qtFormRow('Blocked By', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;" id="qt-d-blocked-wrap">' + blockedByBadges +
            '<button class="qt-edit-btn" id="qt-d-blocked-add" title="Add blocked-by">➕</button></div>') +
        qtFormRow('Notes', '<textarea id="qt-d-notes">' + qtEsc(todo.notes || '') + '</textarea>') +
        qtRenderScopeSection(qtFormScope) +
        qtRenderRefsSection(qtFormRefs) +
        qtRenderDatesSection(todo) +
        '<div class="qt-form-actions">' +
        '<button class="icon-btn" id="qt-btn-delete" style="color:var(--vscode-errorForeground);">🗑️ Delete</button>' +
        '</div></div>';

    ['qt-d-title','qt-d-desc','qt-d-notes'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', qtAutoSave);
    });

    document.getElementById('qt-d-priority').addEventListener('change', qtAutoSave);
    document.getElementById('qt-btn-delete').addEventListener('click', function() {
        var delQuestId = (todo._resolvedQuestId) || qtCurrentQuestId;
        vscode.postMessage({ type: 'qtDeleteTodo', questId: delQuestId, todoId: todo.id, sourceFile: todo._sourceFile, fromBackup: qtViewingBackup });
    });

    document.getElementById('qt-d-tag-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && this.value.trim()) {
            qtFormTags.push(this.value.trim());
            this.value = '';
            qtRefreshTagChips();
            qtAutoSave();
        }
    });
    document.getElementById('qt-d-tag-picker-btn').addEventListener('click', function() { qtShowTagPicker(); });

    document.getElementById('qt-d-status').addEventListener('change', function() {
        var newStatus = this.value;
        var sel = this;
        var cdInput = document.getElementById('qt-d-completed-date');
        var cbInput = document.getElementById('qt-d-completed-by');
        if (newStatus === 'completed' || newStatus === 'cancelled') {
            var prev = (qtDetailTodo && qtDetailTodo.status) ? qtDetailTodo.status : 'not-started';
            sel.value = prev;
            qtPendingStatusChange = { status: newStatus, previous: prev };
            vscode.postMessage({ type: 'qtConfirmStatusUpdate', status: newStatus });
            return;
        }
        // Any non-terminal status clears completion metadata
        if (cdInput) cdInput.value = '';
        if (cbInput) cbInput.value = '';
        if (qtDetailTodo) qtDetailTodo.status = newStatus;
        qtAutoSave();
    });

    qtAttachTodoBadgeHandlers('blocked-by');
    qtAttachTodoBadgeHandlers('deps');
    document.getElementById('qt-d-blocked-add').addEventListener('click', function() { qtShowTodoPicker('blocked-by'); });
    document.getElementById('qt-d-deps-add').addEventListener('click', function() { qtShowTodoPicker('deps'); });

    qtAttachTagRemoveHandlers();
    qtAttachSectionHandlers();
    qtAttachScopeFileHandlers();
    qtAttachRefHandlers();

    var pathsToCheck = [];
    (qtFormScope && qtFormScope.files ? qtFormScope.files : []).forEach(function(p) { pathsToCheck.push(p); });
    qtFormRefs.forEach(function(r) { if (r.path) pathsToCheck.push(r.path); });
    qtRequestPathExtAppAvailability(pathsToCheck);

    vscode.postMessage({ type: 'qtCheckExtApp', questId: qtCurrentQuestId, file: qtCurrentFile });
}

// ── Todo badge rendering for blocked-by / dependencies ──
function qtRenderTodoBadges(ids, category) {
    return ids.map(function(id) {
        return '<span class="qt-todo-badge" data-qt-badge-cat="' + category + '" data-qt-badge-id="' + qtEsc(id) + '" title="Navigate to ' + qtEsc(id) + '">' +
            qtEsc(id) +
            '<span class="qt-badge-remove" data-qt-badge-cat="' + category + '" data-qt-badge-id="' + qtEsc(id) + '">×</span>' +
            '</span>';
    }).join('');
}

function qtAttachTodoBadgeHandlers(category) {
    var wrapId = category === 'blocked-by' ? 'qt-d-blocked-wrap' : 'qt-d-deps-wrap';
    var wrap = document.getElementById(wrapId);
    if (!wrap) return;
    wrap.querySelectorAll('.qt-todo-badge[data-qt-badge-cat="' + category + '"]').forEach(function(badge) {
        badge.addEventListener('click', function(e) {
            if (e.target.closest('.qt-badge-remove')) return;
            // Navigate to the referenced todo
            var tid = badge.dataset.qtBadgeId;
            if (tid) {
                var targetQuestId = qtCurrentQuestId;
                var targetTodoId = tid;
                var slashIdx = tid.indexOf('/');
                if (slashIdx > 0) {
                    targetQuestId = tid.substring(0, slashIdx);
                    targetTodoId = tid.substring(slashIdx + 1);
                }
                qtSelectedTodoId = tid;
                qtNavPush(tid);
                qtRenderList();
                vscode.postMessage({ type: 'qtGetTodo', questId: targetQuestId, todoId: targetTodoId });
            }
        });
    });
    wrap.querySelectorAll('.qt-badge-remove[data-qt-badge-cat="' + category + '"]').forEach(function(rm) {
        rm.addEventListener('click', function(e) {
            e.stopPropagation();
            var tid = rm.dataset.qtBadgeId;
            var field = category === 'blocked-by' ? 'blocked_by' : 'dependencies';
            var arr = qtDetailTodo[field] || [];
            var idx = arr.indexOf(tid);
            if (idx >= 0) arr.splice(idx, 1);
            qtDetailTodo[field] = arr;
            // Re-render badges
            var badgesHtml = qtRenderTodoBadges(arr, category);
            var addBtn = wrap.querySelector('#qt-d-' + (category === 'blocked-by' ? 'blocked' : 'deps') + '-add');
            wrap.innerHTML = badgesHtml + addBtn.outerHTML;
            qtAttachTodoBadgeHandlers(category);
            wrap.querySelector('#qt-d-' + (category === 'blocked-by' ? 'blocked' : 'deps') + '-add').addEventListener('click', function() { qtShowTodoPicker(category); });
            qtAutoSave();
        });
    });
}

function qtShowTodoPicker(category) {
    qtClosePopup();
    window._qtTodoPickerCategory = category;
    qtShowPopup('<h4>Loading todos...</h4>');
    var currentQuest = qtCurrentQuestId;
    var pickerScope = 'local';
    if (!currentQuest || currentQuest === '__all_quests__' || currentQuest === '__all_workspace__') {
        pickerScope = 'workspace';
    }
    vscode.postMessage({ type: 'qtGetTodosForPicker', source: pickerScope, questId: currentQuest });
    qtTagPickerCallback = null; // reuse mechanism
}

function qtRenderTodoPickerPopup(allTodos, category) {
    var field = category === 'blocked-by' ? 'blocked_by' : 'dependencies';
    var current = (qtDetailTodo && qtDetailTodo[field]) || [];
    var currentSet = {};
    current.forEach(function(id) { currentSet[id] = true; });
    var filtered = allTodos.filter(function(t) {
        if (!qtDetailTodo) return true;
        var ownRefs = [qtDetailTodo.id, (qtCurrentQuestId ? (qtCurrentQuestId + '/' + qtDetailTodo.id) : '')];
        return ownRefs.indexOf(t.ref || t.id) === -1;
    });
    var questSel = document.getElementById('qt-quest-select');
    var questOptions = [];
    // If main quest select is hidden (session/workspace mode), use cached quest list
    if (questSel && questSel.style.display !== 'none') {
        questSel.querySelectorAll('option').forEach(function(o) {
            var v = o.value;
            if (!v || v.indexOf('__') === 0) return;
            questOptions.push('<option value="' + qtEsc(v) + '">' + qtEsc(v) + '</option>');
        });
    } else if (window._qtPickerQuestList) {
        window._qtPickerQuestList.forEach(function(q) {
            questOptions.push('<option value="' + qtEsc(q) + '">' + qtEsc(q) + '</option>');
        });
    }
    var html = '<h4>Select ' + (category === 'blocked-by' ? 'Blocked By' : 'Dependencies') + '</h4>' +
        '<div class="qt-inline-row" style="margin-bottom:6px;">' +
        '<select id="qt-tp-source" style="flex:1;">' +
        '<option value="local">Local todos (current quest)</option>' +
        '<option value="quest">Quest todos (select quest)</option>' +
        '<option value="workspace">Workspace todos</option>' +
        '</select>' +
        '<select id="qt-tp-quest" style="flex:1;display:none;">' + questOptions.join('') + '</select>' +
        '</div>' +
        '<input id="qt-tp-filter" placeholder="Filter todos..." style="width:100%;margin-bottom:6px;">' +
        '<div class="qt-tag-picker-list" id="qt-todo-picker-list" style="max-height:250px;overflow-y:auto;">';
    filtered.forEach(function(t) {
        var refId = t.ref || t.id;
        var checked = currentSet[refId];
        html += '<div class="qt-tag-picker-item" data-qt-pick-tag="' + qtEsc(refId) + '">' +
            '<input type="checkbox"' + (checked ? ' checked' : '') + '> ' +
            '<span style="font-weight:600;">' + qtEsc(refId) + '</span> — ' + qtEsc(t.title || '') + '</div>';
    });
    html += '</div><div class="qt-popup-actions">' +
        '<button class="primary" id="qt-tp-ok">OK</button>' +
        '<button class="icon-btn" id="qt-tp-cancel">Cancel</button></div>';
    qtShowPopup(html);
    var sourceEl = document.getElementById('qt-tp-source');
    var questPickEl = document.getElementById('qt-tp-quest');
    var refreshPickerData = function() {
        var source = sourceEl ? sourceEl.value : 'local';
        var questId = source === 'quest' && questPickEl ? questPickEl.value : qtCurrentQuestId;
        if (questPickEl) questPickEl.style.display = source === 'quest' ? '' : 'none';
        vscode.postMessage({ type: 'qtGetTodosForPicker', source: source, questId: questId });
    };
    if (sourceEl) {
        // Default to 'local' for regular quests and session mode, 'workspace' for __all_workspace__/__all_quests__
        var isSessionOrReal = qtCurrentQuestId && (qtCurrentQuestId === '__session__' || qtCurrentQuestId.indexOf('__') !== 0);
        sourceEl.value = isSessionOrReal ? 'local' : 'workspace';
        sourceEl.addEventListener('change', refreshPickerData);
    }
    if (questPickEl) {
        if (qtCurrentQuestId && qtCurrentQuestId.indexOf('__') !== 0) questPickEl.value = qtCurrentQuestId;
        questPickEl.addEventListener('change', refreshPickerData);
    }
    // Filter
    document.getElementById('qt-tp-filter').addEventListener('input', function() {
        var q = this.value.toLowerCase();
        document.querySelectorAll('#qt-todo-picker-list .qt-tag-picker-item').forEach(function(item) {
            item.style.display = (item.dataset.qtPickTag || '').toLowerCase().indexOf(q) >= 0 || item.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
        });
    });
    qtAttachTagPickerItemHandlers();
    document.getElementById('qt-tp-ok').addEventListener('click', function() {
        var selected = [];
        document.querySelectorAll('#qt-todo-picker-list .qt-tag-picker-item').forEach(function(item) {
            var cb = item.querySelector('input[type="checkbox"]');
            if (cb && cb.checked) selected.push(item.dataset.qtPickTag);
        });
        var merged = (qtDetailTodo && qtDetailTodo[field]) ? qtDetailTodo[field].slice() : [];
        selected.forEach(function(id) {
            if (merged.indexOf(id) < 0) merged.push(id);
        });
        if (qtDetailTodo) qtDetailTodo[field] = merged;
        qtClosePopup();
        window._qtTodoPickerCategory = null;
        // Re-render the badges
        var wrapId = category === 'blocked-by' ? 'qt-d-blocked-wrap' : 'qt-d-deps-wrap';
        var wrap = document.getElementById(wrapId);
        if (wrap) {
            var addBtnId = category === 'blocked-by' ? 'qt-d-blocked-add' : 'qt-d-deps-add';
            wrap.innerHTML = qtRenderTodoBadges(merged, category) +
                '<button class="qt-edit-btn" id="' + addBtnId + '" title="Add ' + (category === 'blocked-by' ? 'blocked-by' : 'dependency') + '">➕</button>';
            qtAttachTodoBadgeHandlers(category);
            document.getElementById(addBtnId).addEventListener('click', function() { qtShowTodoPicker(category); });
        }
        qtAutoSave();
    });
    document.getElementById('qt-tp-cancel').addEventListener('click', function() {
        window._qtTodoPickerCategory = null;
        qtClosePopup();
    });
}

function qtUpdateTodoPickerList(allTodos, category) {
    var list = document.getElementById('qt-todo-picker-list');
    if (!list) {
        qtRenderTodoPickerPopup(allTodos, category);
        return;
    }
    var field = category === 'blocked-by' ? 'blocked_by' : 'dependencies';
    var current = (qtDetailTodo && qtDetailTodo[field]) || [];
    var currentSet = {};
    current.forEach(function(id) { currentSet[id] = true; });
    var filtered = allTodos.filter(function(t) {
        if (!qtDetailTodo) return true;
        var ownRefs = [qtDetailTodo.id, (qtCurrentQuestId ? (qtCurrentQuestId + '/' + qtDetailTodo.id) : '')];
        return ownRefs.indexOf(t.ref || t.id) === -1;
    });
    list.innerHTML = filtered.map(function(t) {
        var refId = t.ref || t.id;
        var checked = currentSet[refId];
        return '<div class="qt-tag-picker-item" data-qt-pick-tag="' + qtEsc(refId) + '">' +
            '<input type="checkbox"' + (checked ? ' checked' : '') + '> ' +
            '<span style="font-weight:600;">' + qtEsc(refId) + '</span> — ' + qtEsc(t.title || '') + '</div>';
    }).join('');
    qtAttachTagPickerItemHandlers();
}

// ── Section renderers ──
function qtRenderScopeSection(scope) {
    var summary = qtBuildScopeSummary(scope);
    var filesBody = '';
    if (scope && scope.files && scope.files.length) {
        filesBody = '<div id="qt-scope-files-wrap" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px;">' +
            qtRenderScopeFilesBadges(scope.files) + '</div>';
    }
    return '<div class="qt-section-header" data-qt-section="scope">' +
        '<span class="codicon codicon-chevron-down"></span> Scope ' +
        '<button class="qt-edit-btn" id="qt-scope-edit-btn" title="Edit scope">✏️</button></div>' +
        '<div class="qt-section-body" data-qt-section-body="scope">' +
        '<div class="qt-scope-summary">' + qtEsc(summary) + '</div>' + filesBody + '</div>';
}

function qtGetScopeProjects(scope) {
    if (!scope) return [];
    if (scope.projects && scope.projects.length) return scope.projects.slice();
    if (scope.project) return [scope.project];
    return [];
}

function qtBuildScopeSummary(scope) {
    var summary = '(none)';
    if (scope) {
        var parts = [];
        var projects = qtGetScopeProjects(scope);
        if (projects.length) parts.push('projects: ' + projects.join(', '));
        if (scope.module) parts.push('module: ' + scope.module);
        if (scope.area) parts.push('area: ' + scope.area);
        if (scope.files && scope.files.length) parts.push(scope.files.length + ' file(s)');
        if (parts.length) summary = parts.join(', ');
    }
    return summary;
}

function qtRenderScopeFilesBadges(files) {
    return files.map(function(filePath) {
        var extBtn = qtPathExtAppAvailability[filePath] ? '<span class="qt-file-badge-ext" data-qt-file-ext="' + qtEsc(filePath) + '" title="Open in external app">🖥️</span>' : '';
        return '<span class="qt-file-badge" data-qt-file-path="' + qtEsc(filePath) + '" title="Open in editor">' +
            extBtn +
            '<span class="qt-file-badge-name">' + qtEsc(filePath) + '</span>' +
            '<span class="qt-file-badge-rm" data-qt-file-rm="' + qtEsc(filePath) + '" title="Remove">×</span>' +
            '</span>';
    }).join('');
}

function qtAttachScopeFileHandlers() {
    var wrap = document.getElementById('qt-scope-files-wrap');
    if (!wrap) return;
    wrap.querySelectorAll('.qt-file-badge').forEach(function(badge) {
        badge.addEventListener('click', function(e) {
            if (e.target.closest('.qt-file-badge-rm') || e.target.closest('.qt-file-badge-ext')) return;
            var p = badge.dataset.qtFilePath;
            if (p) vscode.postMessage({ type: 'qtOpenInEditor', path: p });
        });
    });
    wrap.querySelectorAll('.qt-file-badge-rm').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var p = btn.dataset.qtFileRm;
            if (!qtFormScope || !qtFormScope.files || !p) return;
            qtFormScope.files = qtFormScope.files.filter(function(f) { return f !== p; });
            if (!qtFormScope.files.length) delete qtFormScope.files;
            qtRefreshScopeBody();
            qtAutoSave();
        });
    });
    wrap.querySelectorAll('.qt-file-badge-ext').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var p = btn.dataset.qtFileExt;
            if (p) vscode.postMessage({ type: 'qtOpenRefExtApp', path: p });
        });
    });
}

function qtRefreshScopeBody(skipAvailabilityRefresh) {
    var body = document.querySelector('[data-qt-section-body="scope"]');
    if (!body) return;
    var summary = qtBuildScopeSummary(qtFormScope);
    var files = (qtFormScope && qtFormScope.files) ? qtFormScope.files : [];
    var filesBody = files.length
        ? '<div id="qt-scope-files-wrap" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px;">' + qtRenderScopeFilesBadges(files) + '</div>'
        : '';
    body.innerHTML = '<div class="qt-scope-summary">' + qtEsc(summary) + '</div>' + filesBody;
    qtAttachScopeFileHandlers();
    if (!skipAvailabilityRefresh) {
        qtRequestPathExtAppAvailability(files);
    }
}

function qtRenderRefsSection(refs) {
    var body = '';
    if (refs && refs.length) {
        body = '<div class="qt-ref-list">' + refs.map(function(r, i) {
            var pathText = r.path || '';
            if (pathText && r.lines) pathText += ' [' + r.lines + ']';
            var urlText = r.url || '';
            var descLine = r.description ? '<div style="font-size:11px;font-weight:600;">' + qtEsc(r.description) + '</div>' : '';
            var pathLine = pathText ? '<div style="font-size:11px;opacity:0.7;">Path: ' + qtEsc(pathText) + '</div>' : '';
            var urlLine = urlText ? '<div style="font-size:11px;opacity:0.7;">URL: ' + qtEsc(urlText) + '</div>' : '';
            var targetLine = (pathLine || urlLine) ? (pathLine + urlLine) : '<div style="font-size:11px;opacity:0.7;">(ref)</div>';
            var openInEditorBtn = '<button class="qt-edit-btn qt-ref-open-btn" data-qt-ref-idx="' + i + '" title="Open in editor">📄</button>';
            var openInExtBtn = (r.path && qtPathExtAppAvailability[r.path]) ? '<button class="qt-edit-btn qt-ref-ext-btn" data-qt-ref-idx="' + i + '" title="Open in external app">🖥️</button>' : '';
            return '<div class="qt-ref-item">' +
                '<span class="qt-ref-text">' + (descLine || '<div style="font-size:11px;font-weight:600;">(no description)</div>') + targetLine + '</span>' +
                openInEditorBtn + openInExtBtn +
                '<button class="qt-edit-btn qt-ref-edit-btn" data-qt-ref-idx="' + i + '" title="Edit">✏️</button>' +
                '<button class="qt-edit-btn qt-ref-rm-btn" data-qt-ref-idx="' + i + '" title="Remove">🗑️</button></div>';
        }).join('') + '</div>';
    } else {
        body = '<div class="qt-scope-summary">(none)</div>';
    }
    return '<div class="qt-section-header" data-qt-section="refs">' +
        '<span class="codicon codicon-chevron-down"></span> References ' +
        '<button class="qt-edit-btn" id="qt-ref-add-btn" title="Add reference">➕</button></div>' +
        '<div class="qt-section-body" data-qt-section-body="refs">' + body + '</div>';
}

function qtRenderDatesSection(todo) {
    return '<div class="qt-section-header" data-qt-section="dates">' +
        '<span class="codicon codicon-chevron-down"></span> Dates</div>' +
        '<div class="qt-section-body" data-qt-section-body="dates">' +
        '<div class="qt-inline-row">' +
        qtFormRow('Created', '<input type="date" id="qt-d-created-date" value="' + qtEsc(todo.created || '') + '">') +
        qtFormRow('Updated', '<input type="date" value="' + qtEsc(todo.updated || '') + '" readonly class="qt-readonly">') +
        '</div>' +
        '<div class="qt-inline-row">' +
        qtFormRow('Completed', '<input type="date" id="qt-d-completed-date" value="' + qtEsc(todo.completed_date || '') + '">') +
        qtFormRow('By', '<input id="qt-d-completed-by" value="' + qtEsc(todo.completed_by || '') + '">') +
        '</div></div>';
}

// Wire autosave on date fields (called after section rendered)
function qtAttachDateAutoSave() {
    var crEl = document.getElementById('qt-d-created-date');
    var cdEl = document.getElementById('qt-d-completed-date');
    var cbEl = document.getElementById('qt-d-completed-by');
    if (crEl) crEl.addEventListener('change', qtAutoSave);
    if (cdEl) cdEl.addEventListener('change', qtAutoSave);
    if (cbEl) cbEl.addEventListener('input', qtAutoSave);
}

// ── Tag helpers ──
function qtRenderTagChipsHtml(tags) {
    return tags.map(function(t) {
        return '<span class="qt-tag-chip">' + qtEsc(t) +
            '<span class="qt-remove-tag" data-qt-tag="' + qtEsc(t) + '">×</span></span>';
    }).join('');
}

function qtRefreshTagChips() {
    var c = document.getElementById('qt-d-tags');
    if (!c) return;
    c.innerHTML = qtRenderTagChipsHtml(qtFormTags);
    qtAttachTagRemoveHandlers();
}

function qtAttachTagRemoveHandlers() {
    document.querySelectorAll('#qt-d-tags .qt-remove-tag').forEach(function(el) {
        el.addEventListener('click', function() {
            var idx = qtFormTags.indexOf(el.dataset.qtTag);
            if (idx >= 0) qtFormTags.splice(idx, 1);
            qtRefreshTagChips();
            qtAutoSave();
        });
    });
}

// ── Collapsible section + scope/ref event wiring ──
function qtAttachSectionHandlers() {
    document.querySelectorAll('.qt-section-header').forEach(function(hdr) {
        hdr.addEventListener('click', function(e) {
            if (e.target.closest('.qt-edit-btn')) return;
            hdr.classList.toggle('collapsed');
            var key = hdr.dataset.qtSection;
            var body = document.querySelector('[data-qt-section-body="' + key + '"]');
            if (body) body.classList.toggle('hidden');
        });
    });
    var scopeBtn = document.getElementById('qt-scope-edit-btn');
    if (scopeBtn) scopeBtn.addEventListener('click', function(e) { e.stopPropagation(); qtShowScopePopup(); });
}

function qtAttachRefHandlers() {
    var addBtn = document.getElementById('qt-ref-add-btn');
    if (addBtn) addBtn.addEventListener('click', function(e) { e.stopPropagation(); qtShowRefPopup(-1); });
    document.querySelectorAll('.qt-ref-edit-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) { e.stopPropagation(); qtShowRefPopup(parseInt(btn.dataset.qtRefIdx)); });
    });
    document.querySelectorAll('.qt-ref-rm-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            qtFormRefs.splice(parseInt(btn.dataset.qtRefIdx), 1);
            qtRefreshRefsBody();
            qtAutoSave();
        });
    });
    document.querySelectorAll('.qt-ref-open-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var ref = qtFormRefs[parseInt(btn.dataset.qtRefIdx)];
            if (ref && (ref.path || ref.url)) {
                vscode.postMessage({ type: 'qtOpenInEditor', path: ref.path, url: ref.url, lines: ref.lines });
            }
        });
    });
    document.querySelectorAll('.qt-ref-ext-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var ref = qtFormRefs[parseInt(btn.dataset.qtRefIdx)];
            if (ref && ref.path) vscode.postMessage({ type: 'qtOpenRefExtApp', path: ref.path });
        });
    });
    qtAttachDateAutoSave();
}

function qtRefreshRefsBody(skipAvailabilityRefresh) {
    var body = document.querySelector('[data-qt-section-body="refs"]');
    if (!body) return;
    if (qtFormRefs.length) {
        body.innerHTML = '<div class="qt-ref-list">' + qtFormRefs.map(function(r, i) {
            var pathText = r.path || '';
            if (pathText && r.lines) pathText += ' [' + r.lines + ']';
            var urlText = r.url || '';
            var descLine = r.description ? '<div style="font-size:11px;font-weight:600;">' + qtEsc(r.description) + '</div>' : '';
            var pathLine = pathText ? '<div style="font-size:11px;opacity:0.7;">Path: ' + qtEsc(pathText) + '</div>' : '';
            var urlLine = urlText ? '<div style="font-size:11px;opacity:0.7;">URL: ' + qtEsc(urlText) + '</div>' : '';
            var targetLine = (pathLine || urlLine) ? (pathLine + urlLine) : '<div style="font-size:11px;opacity:0.7;">(ref)</div>';
            var openInEditorBtn = '<button class="qt-edit-btn qt-ref-open-btn" data-qt-ref-idx="' + i + '" title="Open in editor">📄</button>';
            var openInExtBtn = (r.path && qtPathExtAppAvailability[r.path]) ? '<button class="qt-edit-btn qt-ref-ext-btn" data-qt-ref-idx="' + i + '" title="Open in external app">🖥️</button>' : '';
            return '<div class="qt-ref-item">' +
                '<span class="qt-ref-text">' + (descLine || '<div style="font-size:11px;font-weight:600;">(no description)</div>') + targetLine + '</span>' +
                openInEditorBtn + openInExtBtn +
                '<button class="qt-edit-btn qt-ref-edit-btn" data-qt-ref-idx="' + i + '" title="Edit">✏️</button>' +
                '<button class="qt-edit-btn qt-ref-rm-btn" data-qt-ref-idx="' + i + '" title="Remove">🗑️</button></div>';
        }).join('') + '</div>';
    } else {
        body.innerHTML = '<div class="qt-scope-summary">(none)</div>';
    }
    if (!skipAvailabilityRefresh) {
        var refPaths = qtFormRefs.filter(function(r) { return !!r.path; }).map(function(r) { return r.path; });
        qtRequestPathExtAppAvailability(refPaths);
    }
    qtAttachRefHandlers();
}

function qtRequestPathExtAppAvailability(paths) {
    var uniq = [];
    var seen = {};
    (paths || []).forEach(function(p) {
        if (!p || seen[p]) return;
        seen[p] = true;
        uniq.push(p);
    });
    if (uniq.length) {
        vscode.postMessage({ type: 'qtCheckPathExtApps', paths: uniq });
    }
}

// ── Popup infrastructure ──
function qtShowPopup(html) {
    var ov = document.getElementById('qt-popup-overlay');
    var ct = document.getElementById('qt-popup-content');
    if (!ov || !ct) return;
    ct.innerHTML = html;
    ov.classList.add('visible');
    if (!window._qtPopupOverlayCloseBound) {
        window._qtPopupOverlayCloseBound = true;
        ov.addEventListener('click', function(e) {
            if (e.target === ov) {
                window._qtTodoPickerCategory = null;
                qtClosePopup();
            }
        });
    }
}
function qtClosePopup() {
    var ov = document.getElementById('qt-popup-overlay');
    var ct = document.getElementById('qt-popup-content');
    if (ov) ov.classList.remove('visible');
    if (ct) ct.innerHTML = '';
}

function qtShowScopePopup() {
    var s = qtFormScope || {};
    var projects = qtGetScopeProjects(s);
    window._qtScopePopupProjects = projects.slice();
    window._qtScopePopupFiles = (s.files || []).slice();

    var html = '<h4>Edit Scope</h4>' +
        qtFormRow('Projects', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">' +
            '<div id="qt-p-scope-projects" style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;flex:1;"></div>' +
            '<button class="qt-edit-btn" id="qt-p-scope-projects-pick" title="Pick projects">📦 Pick...</button></div>') +
        qtFormRow('Module', '<input id="qt-p-scope-module" list="qt-dl-modules" value="' + qtEsc(s.module || '') + '" placeholder="Select or type...">' +
            '<datalist id="qt-dl-modules"></datalist>') +
        qtFormRow('Area', '<input id="qt-p-scope-area" list="qt-dl-areas" value="' + qtEsc(s.area || '') + '" placeholder="Select or type...">' +
            '<datalist id="qt-dl-areas"></datalist>') +
        qtFormRow('Files', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">' +
            '<div id="qt-p-scope-files-badges" style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;flex:1;"></div>' +
            '<button class="qt-edit-btn" id="qt-p-scope-files-browse" title="Browse workspace files">📂 Browse...</button></div>') +
        '<div class="qt-popup-actions">' +
        '<button class="primary" id="qt-p-scope-ok">OK</button>' +
        '<button class="icon-btn" id="qt-p-scope-cancel">Cancel</button></div>';
    qtShowPopup(html);

    var renderProjects = function() {
        var el = document.getElementById('qt-p-scope-projects');
        if (!el) return;
        var arr = window._qtScopePopupProjects || [];
        if (!arr.length) {
            el.innerHTML = '<span class="qt-scope-summary">(none)</span>';
            return;
        }
        el.innerHTML = arr.map(function(p) {
            return '<span class="qt-tag-chip" data-qt-scope-proj="' + qtEsc(p) + '">' + qtEsc(p) +
                '<span class="qt-remove-tag" data-qt-scope-proj-rm="' + qtEsc(p) + '">×</span></span>';
        }).join('');
        el.querySelectorAll('[data-qt-scope-proj-rm]').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var p = btn.dataset.qtScopeProjRm;
                window._qtScopePopupProjects = (window._qtScopePopupProjects || []).filter(function(v) { return v !== p; });
                renderProjects();
            });
        });
    };

    var renderFiles = function() {
        var el = document.getElementById('qt-p-scope-files-badges');
        if (!el) return;
        var arr = window._qtScopePopupFiles || [];
        if (!arr.length) {
            el.innerHTML = '<span class="qt-scope-summary">(none)</span>';
            return;
        }
        el.innerHTML = arr.map(function(p) {
            var extBtn = qtPathExtAppAvailability[p] ? '<span class="qt-file-badge-ext" data-qt-scope-file-ext="' + qtEsc(p) + '" title="Open in external app">🖥️</span>' : '';
            return '<span class="qt-file-badge" data-qt-scope-file="' + qtEsc(p) + '">' +
                extBtn +
                '<span class="qt-file-badge-name">' + qtEsc(p) + '</span>' +
                '<span class="qt-file-badge-rm" data-qt-scope-file-rm="' + qtEsc(p) + '" title="Remove">×</span></span>';
        }).join('');
        el.querySelectorAll('[data-qt-scope-file]').forEach(function(badge) {
            badge.addEventListener('click', function(e) {
                if (e.target.closest('[data-qt-scope-file-rm]') || e.target.closest('[data-qt-scope-file-ext]')) return;
                var p = badge.dataset.qtScopeFile;
                if (p) vscode.postMessage({ type: 'qtOpenInEditor', path: p });
            });
        });
        el.querySelectorAll('[data-qt-scope-file-rm]').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var p = btn.dataset.qtScopeFileRm;
                window._qtScopePopupFiles = (window._qtScopePopupFiles || []).filter(function(v) { return v !== p; });
                renderFiles();
            });
        });
        el.querySelectorAll('[data-qt-scope-file-ext]').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var p = btn.dataset.qtScopeFileExt;
                if (p) vscode.postMessage({ type: 'qtOpenRefExtApp', path: p });
            });
        });
        qtRequestPathExtAppAvailability(arr);
    };

    window._qtRenderScopePopupProjects = renderProjects;
    window._qtRenderScopePopupFiles = renderFiles;
    renderProjects();
    renderFiles();

    vscode.postMessage({ type: 'qtGetScopeData' });
    document.getElementById('qt-p-scope-projects-pick').addEventListener('click', function() {
        vscode.postMessage({ type: 'qtPickProjects', selected: window._qtScopePopupProjects || [] });
    });
    document.getElementById('qt-p-scope-files-browse').addEventListener('click', function() {
        vscode.postMessage({ type: 'qtBrowseFile', purpose: 'scope-files' });
    });
    document.getElementById('qt-p-scope-ok').addEventListener('click', function() {
        var projList = (window._qtScopePopupProjects || []).slice();
        var mod = document.getElementById('qt-p-scope-module').value.trim();
        var area = document.getElementById('qt-p-scope-area').value.trim();
        var files = (window._qtScopePopupFiles || []).slice();
        if (!projList.length && !mod && !area && !files.length) {
            qtFormScope = null;
        } else {
            qtFormScope = {};
            if (projList.length) {
                qtFormScope.projects = projList;
                qtFormScope.project = projList[0];
            }
            if (mod) qtFormScope.module = mod;
            if (area) qtFormScope.area = area;
            if (files.length) qtFormScope.files = files;
        }
        qtClosePopup();
        qtRefreshScopeBody();
        qtAutoSave();
    });
    document.getElementById('qt-p-scope-cancel').addEventListener('click', function() {
        qtClosePopup();
    });
}

function qtShowRefPopup(editIdx) {
    var r = editIdx >= 0 ? (qtFormRefs[editIdx] || {}) : {};
    var title = editIdx >= 0 ? 'Edit Reference' : 'Add Reference';
    var html = '<h4>' + title + '</h4>' +
        qtFormRow('Path', '<div style="display:flex;gap:4px;align-items:center;"><input id="qt-p-ref-path" value="' + qtEsc(r.path || '') + '" placeholder="Relative file path" style="flex:1;">' +
            '<button class="qt-edit-btn" id="qt-p-ref-browse" title="Browse...">📂</button></div>') +
        qtFormRow('URL', '<input id="qt-p-ref-url" value="' + qtEsc(r.url || '') + '" placeholder="https://...">') +
        qtFormRow('Description', '<input id="qt-p-ref-desc" value="' + qtEsc(r.description || '') + '">') +
        qtFormRow('Lines', '<input id="qt-p-ref-lines" value="' + qtEsc(r.lines || '') + '" placeholder="e.g. 10-20">') +
        '<div class="qt-popup-actions">' +
        '<button class="primary" id="qt-p-ref-ok">OK</button>' +
        '<button class="icon-btn" id="qt-p-ref-cancel">Cancel</button></div>';
    qtShowPopup(html);
    document.getElementById('qt-p-ref-browse').addEventListener('click', function() {
        vscode.postMessage({ type: 'qtBrowseFile', purpose: 'ref-path' });
    });
    document.getElementById('qt-p-ref-ok').addEventListener('click', function() {
        var ref = {};
        var p = document.getElementById('qt-p-ref-path').value.trim();
        var u = document.getElementById('qt-p-ref-url').value.trim();
        var d = document.getElementById('qt-p-ref-desc').value.trim();
        var l = document.getElementById('qt-p-ref-lines').value.trim();
        if (p) ref.path = p;
        if (u) ref.url = u;
        if (d) ref.description = d;
        if (l) ref.lines = l;
        if (!p && !u && !d) { qtClosePopup(); return; }
        if (editIdx >= 0) { qtFormRefs[editIdx] = ref; } else { qtFormRefs.push(ref); }
        qtClosePopup();
        qtRefreshRefsBody();
        qtAutoSave();
    });
    document.getElementById('qt-p-ref-cancel').addEventListener('click', qtClosePopup);
}

function qtShowTagPicker() {
    qtTagPickerCallback = function(allTags) {
        var currentSet = {};
        qtFormTags.forEach(function(t) { currentSet[t] = true; });
        var selectedQuest = qtTagPickerScope === 'quest' ? ' selected' : '';
        var selectedAll = qtTagPickerScope === 'all' ? ' selected' : '';
        var html = '<h4>Select Tags</h4>' +
            '<div class="qt-inline-row" style="margin-bottom:6px;">' +
            '<select id="qt-p-tag-scope" style="flex:1;">' +
            '<option value="quest"' + selectedQuest + '>Only this quest</option>' +
            '<option value="all"' + selectedAll + '>All quests in workspace</option></select></div>' +
            '<input id="qt-p-tag-filter" placeholder="Filter tags..." style="width:100%;margin-bottom:6px;">' +
            '<div class="qt-tag-picker-list" id="qt-tag-picker-list">' +
            qtBuildTagPickerItems(allTags, currentSet) +
            '</div>' +
            '<input id="qt-p-new-tag" placeholder="New tag...">' +
            '<div class="qt-popup-actions">' +
            '<button class="primary" id="qt-p-tag-ok">OK</button>' +
            '<button class="icon-btn" id="qt-p-tag-cancel">Cancel</button></div>';
        qtShowPopup(html);
        qtAttachTagPickerItemHandlers();
        document.getElementById('qt-p-tag-scope').addEventListener('change', function() {
            var scope = this.value;
            qtTagPickerScope = (scope === 'quest') ? 'quest' : 'all';
            qtPersistState();
            var questId = scope === 'quest' ? qtCurrentQuestId : '';
            vscode.postMessage({ type: 'qtGetAllTags', questId: questId });
        });
        document.getElementById('qt-p-tag-filter').addEventListener('input', function() {
            var q = this.value.toLowerCase();
            document.querySelectorAll('.qt-tag-picker-item').forEach(function(item) {
                item.style.display = (item.dataset.qtPickTag || '').toLowerCase().indexOf(q) >= 0 ? '' : 'none';
            });
        });
        document.getElementById('qt-p-tag-ok').addEventListener('click', function() {
            var selected = [];
            document.querySelectorAll('.qt-tag-picker-item').forEach(function(item) {
                var cb = item.querySelector('input[type="checkbox"]');
                if (cb && cb.checked) selected.push(item.dataset.qtPickTag);
            });
            var newTag = document.getElementById('qt-p-new-tag').value.trim();
            if (newTag && selected.indexOf(newTag) < 0) selected.push(newTag);
            qtFormTags = selected;
            qtClosePopup();
            qtRefreshTagChips();
            qtAutoSave();
        });
        document.getElementById('qt-p-tag-cancel').addEventListener('click', qtClosePopup);
    };
    vscode.postMessage({ type: 'qtGetAllTags', questId: qtTagPickerScope === 'quest' ? qtCurrentQuestId : '' });
}

function qtBuildTagPickerItems(tags, currentSet) {
    return tags.map(function(t) {
        var sel = currentSet[t] ? ' selected' : '';
        return '<div class="qt-tag-picker-item' + sel + '" data-qt-pick-tag="' + qtEsc(t) + '">' +
            '<input type="checkbox"' + (currentSet[t] ? ' checked' : '') + '> ' + qtEsc(t) + '</div>';
    }).join('');
}

function qtAttachTagPickerItemHandlers() {
    document.querySelectorAll('.qt-tag-picker-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            var cb = item.querySelector('input[type="checkbox"]');
            if (cb && e.target !== cb) cb.checked = !cb.checked;
            item.classList.toggle('selected', cb ? cb.checked : false);
        });
    });
}

function qtCollectFormData() {
    var tags = qtFormTags.slice();
    // Collect blocked-by and deps from badges in the detail todo
    var deps = qtDetailTodo && qtDetailTodo.dependencies ? qtDetailTodo.dependencies.slice() : [];
    var blockedBy = qtDetailTodo && qtDetailTodo.blocked_by ? qtDetailTodo.blocked_by.slice() : [];
    // Fallback: collect from input fields if present (new todo form)
    var depsEl = document.getElementById('qt-d-deps');
    if (depsEl) {
        var depsVal = depsEl.value.trim();
        deps = depsVal ? depsVal.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
    }
    var blockedByEl = document.getElementById('qt-d-blocked-by');
    if (blockedByEl) {
        var blockedByVal = blockedByEl.value.trim();
        blockedBy = blockedByVal ? blockedByVal.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
    }
    var completedDate = document.getElementById('qt-d-completed-date');
    var completedBy = document.getElementById('qt-d-completed-by');
    var completedDateValue = completedDate ? completedDate.value.trim() : '';
    var completedByValue = completedBy ? completedBy.value.trim() : '';
    if (completedDateValue && !completedByValue && qtUserName) {
        completedByValue = qtUserName;
        if (completedBy) completedBy.value = completedByValue;
    }
    var createdEl = document.getElementById('qt-d-created-date') || document.getElementById('qt-d-created');
    var createdValue = createdEl ? createdEl.value.trim() : '';
    return {
        title: document.getElementById('qt-d-title') ? document.getElementById('qt-d-title').value : '',
        status: document.getElementById('qt-d-status') ? document.getElementById('qt-d-status').value : '',
        priority: document.getElementById('qt-d-priority') ? document.getElementById('qt-d-priority').value || undefined : undefined,
        description: document.getElementById('qt-d-desc') ? document.getElementById('qt-d-desc').value : '',
        tags: tags.length ? tags : undefined,
        dependencies: deps.length ? deps : undefined,
        blocked_by: blockedBy.length ? blockedBy : undefined,
        notes: document.getElementById('qt-d-notes') ? document.getElementById('qt-d-notes').value || undefined : undefined,
        scope: qtFormScope || undefined,
        references: qtFormRefs.length ? qtFormRefs : undefined,
        created: createdValue || undefined,
        completed_date: completedDateValue || undefined,
        completed_by: completedByValue || undefined,
    };
}

function qtShowNewTodoForm(id) {
    qtSelectedTodoId = '';
    qtFormTags = [];
    qtFormScope = null;
    qtFormRefs = [];
    qtRenderList();
    var pane = document.getElementById('qt-detail-pane');
    if (!pane) return;
    var today = new Date().toISOString().slice(0, 10);
    pane.innerHTML = '<div class="qt-detail-form">' +
        qtFormRow('ID', '<input id="qt-d-id" value="' + qtEsc(id) + '">') +
        qtFormRow('Created', '<div style="display:flex;gap:4px;align-items:center;">' +
            '<input type="date" id="qt-d-created" value="' + qtEsc(today) + '" style="flex:1;">' +
            '<button class="icon-btn" id="qt-d-created-pick" title="Select date"><span class="codicon codicon-calendar"></span></button></div>') +
        qtFormRow('Title', '<input id="qt-d-title" value="">') +
        qtFormRow('Description', '<textarea id="qt-d-desc"></textarea>') +
        '<div class="qt-inline-row">' +
        qtFormRow('Status', '<select id="qt-d-status">' + qtStatusOptions('not-started') + '</select>') +
        qtFormRow('Priority', '<select id="qt-d-priority">' + qtPriorityOptions('medium') + '</select>') +
        '</div>' +
        qtFormRow('Tags', '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">' +
            '<div class="qt-tag-chips" id="qt-d-tags"></div>' +
            '<input class="qt-tag-input" id="qt-d-tag-input" placeholder="Add tag...">' +
            '<button class="qt-edit-btn" id="qt-d-tag-picker-btn" title="Pick from existing tags">🏷️</button></div>') +
        qtFormRow('Dependencies', '<input id="qt-d-deps" placeholder="Comma-separated IDs">') +
        qtFormRow('Blocked By', '<input id="qt-d-blocked-by" placeholder="Comma-separated: todoId or questId/todoId">') +
        qtFormRow('Notes', '<textarea id="qt-d-notes"></textarea>') +
        qtRenderScopeSection(null) +
        qtRenderRefsSection([]) +
        '<div class="qt-form-actions">' +
        '<button class="primary" id="qt-btn-create"><span class="codicon codicon-add"></span> Create</button>' +
        '<button class="qt-btn-secondary" id="qt-btn-cancel-create">Cancel</button>' +
        '</div></div>';

    document.getElementById('qt-d-tag-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && this.value.trim()) {
            qtFormTags.push(this.value.trim());
            this.value = '';
            qtRefreshTagChips();
        }
    });
    document.getElementById('qt-d-tag-picker-btn').addEventListener('click', function() { qtShowTagPicker(); });
    var createdPickBtn = document.getElementById('qt-d-created-pick');
    if (createdPickBtn) createdPickBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var createdEl = document.getElementById('qt-d-created');
        if (!createdEl) return;
        if (typeof createdEl.showPicker === 'function') createdEl.showPicker();
        else createdEl.focus();
    });
    qtAttachSectionHandlers();
    qtAttachRefHandlers();
    document.getElementById('qt-btn-create').addEventListener('click', function() {
        var data = qtCollectFormData();
        data.id = document.getElementById('qt-d-id') ? document.getElementById('qt-d-id').value.trim() : '';
        var missing = [];
        if (!data.id) missing.push('ID');
        if (!data.description) missing.push('Description');
        if (missing.length) {
            vscode.postMessage({ type: 'qtShowError', message: 'Please enter: ' + missing.join(', ') });
            return;
        }
        vscode.postMessage({ type: 'qtCreateTodo', questId: qtCurrentQuestId, todo: data, file: qtCurrentFile });
    });
    document.getElementById('qt-btn-cancel-create').addEventListener('click', function() {
        var pane = document.getElementById('qt-detail-pane');
        if (pane) pane.innerHTML = '<div class="qt-empty-detail">Select a todo to view details</div>';
    });
}

function qtFormRow(label, input) { return '<div class="qt-form-row"><label>' + label + '</label>' + input + '</div>'; }

function qtShowMassAddOverlay() {
    var overlay = document.getElementById('qt-mass-overlay');
    var panel = document.getElementById('qt-mass-panel');
    if (!overlay || !panel) return;
    var count = 15;
    var html = '<h3>Mass Add Todos</h3>';
    for (var i = 0; i < count; i++) {
        var num = i + 1;
        var defId = 'todo-' + Date.now().toString(36) + '-' + num;
        html += '<div class="qt-mass-row" data-qt-mass-idx="' + i + '">' +
            '<div class="qt-mass-r1">' +
            '<span class="qt-mass-row-num">' + num + '</span>' +
            '<input name="id" placeholder="ID" value="' + defId + '">' +
            '<input name="title" placeholder="Title (required)">' +
            '<select name="priority"><option value="low">low</option><option value="medium" selected>medium</option><option value="high">high</option><option value="critical">critical</option></select>' +
            '</div>' +
            '<div class="qt-mass-r2"><textarea name="description" placeholder="Description (optional)"></textarea></div>' +
            '</div>';
    }
    html += '<div class="qt-mass-footer">' +
        '<button class="secondary" id="qt-mass-cancel">Cancel</button>' +
        '<button class="primary" id="qt-mass-create">Create Todos</button>' +
        '</div>';
    panel.innerHTML = html;
    overlay.classList.add('visible');
    document.getElementById('qt-mass-cancel').addEventListener('click', function() {
        overlay.classList.remove('visible');
    });
    document.getElementById('qt-mass-create').addEventListener('click', function() {
        var rows = panel.querySelectorAll('.qt-mass-row');
        var todos = [];
        for (var j = 0; j < rows.length; j++) {
            var row = rows[j];
            var idVal = row.querySelector('input[name="id"]').value.trim();
            var titleVal = row.querySelector('input[name="title"]').value.trim();
            var priVal = row.querySelector('select[name="priority"]').value;
            var descVal = row.querySelector('textarea[name="description"]').value.trim();
            if (!idVal || !titleVal) continue;
            todos.push({ id: idVal, title: titleVal, priority: priVal, description: descVal || titleVal, status: 'not-started' });
        }
        if (!todos.length) {
            vscode.postMessage({ type: 'qtShowError', message: 'Fill in at least one row (ID + Title required).' });
            return;
        }
        vscode.postMessage({ type: 'qtMassCreate', questId: qtCurrentQuestId, file: qtCurrentFile, todos: todos });
        overlay.classList.remove('visible');
    });
    // Close overlay on background click
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) overlay.classList.remove('visible');
    });
}
function qtEsc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function qtStatusOptions(cur) {
    var opts = ['not-started','in-progress','blocked','completed','cancelled'];
    return opts.map(function(o) { return '<option value="' + o + '"' + (o === cur ? ' selected' : '') + '>' + o + '</option>'; }).join('');
}
function qtPriorityOptions(cur) {
    var opts = ['','low','medium','high','critical'];
    return '<option value="">(none)</option>' + opts.filter(Boolean).map(function(o) { return '<option value="' + o + '"' + (o === cur ? ' selected' : '') + '>' + o + '</option>'; }).join('');
}

// ── Quest TODO Message listener (handled via accordion message routing) ──
function qtHandleMessage(msg) {
    switch(msg.type) {
        case 'qtQuests':
            var sel = document.getElementById('qt-quest-select');
            if (sel) {
                sel.innerHTML = msg.quests.map(function(q) { return '<option value="' + q + '"' + (q === msg.activeQuest ? ' selected' : '') + '>' + q + '</option>'; }).join('') +
                    '<option disabled>──────────</option>' +
                    '<option value="__all_quests__">All quests</option>' +
                    '<option value="__all_workspace__">All workspace todos</option>';
                if (msg.activeQuest) qtCurrentQuestId = msg.activeQuest;
                else if (msg.quests.length) qtCurrentQuestId = msg.quests[0];
            }
            // Pre-select the default file if the backend specifies one
            if (msg.defaultFile) {
                qtCurrentFile = msg.defaultFile;
                var dfsel = document.getElementById('qt-file-select');
                if (dfsel) dfsel.value = msg.defaultFile;
            }
            break;
        case 'qtFiles':
            var fsel = document.getElementById('qt-file-select');
            if (fsel) {
                var curFile = qtCurrentFile;
                fsel.innerHTML = '<option value="all">All files</option>' +
                    msg.files.map(function(f) { return '<option value="' + qtEsc(f) + '"' + (f === curFile ? ' selected' : '') + '>' + qtEsc(f) + '</option>'; }).join('');
                // Explicitly set value after innerHTML rebuild to ensure selection sticks
                if (curFile && curFile !== 'all') fsel.value = curFile;
            }
            break;
        case 'qtTodos':
            // If viewing backup, ignore non-backup refreshes (e.g. from file watchers)
            if (qtViewingBackup && !msg.fromBackup) break;
            qtTodos = msg.todos || [];
            qtRenderList();
            if (qtPendingSelectTodoId) {
                var exists = qtTodos.some(function(t) { return t.id === qtPendingSelectTodoId; });
                if (exists) {
                    qtSelectedTodoId = qtPendingSelectTodoId;
                    qtNavPush(qtSelectedTodoId);
                    qtRenderList();
                    vscode.postMessage({ type: 'qtGetTodo', questId: qtCurrentQuestId, todoId: qtSelectedTodoId });
                    qtPendingSelectTodoId = '';
                    vscode.postMessage({ type: 'qtConsumePendingSelect' });
                }
            }
            break;
        case 'qtTodoDetail':
            if (msg.todo) qtRenderDetail(msg.todo);
            break;
        case 'qtSaved':
            if (msg.success) qtRenderList();
            break;
        case 'qtCreated':
            if (msg.success) {
                qtSelectedTodoId = msg.todo ? (msg.todo.id || '') : '';
                // Auto-refresh list from backend to pick up new todo
                vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
                if (msg.todo) qtRenderDetail(msg.todo);
            }
            break;
        case 'qtDeleted':
            if (msg.success) {
                qtSelectedTodoId = '';
                var dp = document.getElementById('qt-detail-pane');
                if (dp) dp.innerHTML = '<div class="qt-empty-detail">Select a todo to view details</div>';
                // Auto-refresh list from backend
                if (qtViewingBackup) {
                    vscode.postMessage({ type: 'qtGetBackupTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
                } else {
                    vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
                }
                // Re-check backup existence after delete (backup may now exist or be empty)
                vscode.postMessage({ type: 'qtCheckBackupExists', questId: qtCurrentQuestId, file: qtCurrentFile });
            }
            break;
        case 'qtBackupStatus': {
            var bkBtn = document.getElementById('qt-btn-toggle-backup');
            if (bkBtn) {
                bkBtn.style.display = msg.exists ? '' : 'none';
                if (!msg.exists && qtViewingBackup) {
                    qtViewingBackup = false;
                    bkBtn.classList.remove('active-indicator');
                    bkBtn.title = 'Switch to backup file';
                }
            }
            break;
        }
        case 'qtStatusConfirmResult':
            if (!qtPendingStatusChange) break;
            var pending = qtPendingStatusChange;
            qtPendingStatusChange = null;
            if (!msg.confirmed) break;
            var statusSel = document.getElementById('qt-d-status');
            if (statusSel) statusSel.value = pending.status;
            var today = new Date().toISOString().slice(0, 10);
            var cdInput = document.getElementById('qt-d-completed-date');
            var cbInput = document.getElementById('qt-d-completed-by');
            if (cdInput) cdInput.value = today;
            if (cbInput) cbInput.value = qtUserName || cbInput.value || '';
            if (qtDetailTodo) qtDetailTodo.status = pending.status;
            qtAutoSave();
            break;
        case 'qtState':
            if (msg.state) {
                var st = msg.state;
                if (st.sortFields && st.sortFields.length) {
                    qtSortFields = st.sortFields;
                    var sortBtn = document.getElementById('qt-btn-sort');
                    if (sortBtn) sortBtn.classList.add('active-indicator');
                }
                if (st.tagScope === 'quest' || st.tagScope === 'all') {
                    qtTagPickerScope = st.tagScope;
                }
                if (st.filterState) {
                    var fs = st.filterState;
                    qtFilterState = {
                        status: fs.status || [],
                        priority: fs.priority || [],
                        tags: fs.tags || [],
                        createdFrom: fs.createdFrom || '',
                        createdTo: fs.createdTo || '',
                        updatedFrom: fs.updatedFrom || '',
                        updatedTo: fs.updatedTo || '',
                        completedFrom: fs.completedFrom || '',
                        completedTo: fs.completedTo || ''
                    };
                    qtUpdateFilterIndicator();
                }
            }
            break;
        case 'qtPickedProjects':
            if (Array.isArray(msg.projects)) {
                window._qtScopePopupProjects = msg.projects;
                if (window._qtRenderScopePopupProjects) window._qtRenderScopePopupProjects();
            }
            break;
        case 'qtPathExtAppAvailability':
            if (msg.paths) {
                Object.keys(msg.paths).forEach(function(p) { qtPathExtAppAvailability[p] = !!msg.paths[p]; });
                qtRefreshRefsBody(true);
                qtRefreshScopeBody(true);
            }
            break;
        case 'qtAllTags':
            if (msg.tags) {
                if (qtTagPickerCallback) {
                    qtTagPickerCallback(msg.tags);
                    qtTagPickerCallback = null;
                } else {
                    // Scope changed — refresh list in-place preserving checked state
                    var list = document.getElementById('qt-tag-picker-list');
                    if (list) {
                        var checked = {};
                        list.querySelectorAll('.qt-tag-picker-item').forEach(function(it) {
                            var cb = it.querySelector('input[type="checkbox"]');
                            if (cb && cb.checked) checked[it.dataset.qtPickTag] = true;
                        });
                        qtFormTags.forEach(function(t) { checked[t] = true; });
                        list.innerHTML = qtBuildTagPickerItems(msg.tags, checked);
                        qtAttachTagPickerItemHandlers();
                    }
                }
            }
            break;
        case 'qtScopeData':
            // Populate datalists in scope popup
            var dlProj = document.getElementById('qt-dl-projects');
            var dlMod = document.getElementById('qt-dl-modules');
            var dlArea = document.getElementById('qt-dl-areas');
            if (dlProj && msg.projects) dlProj.innerHTML = msg.projects.map(function(p) { return '<option value="' + qtEsc(p) + '">'; }).join('');
            if (dlMod && msg.modules) dlMod.innerHTML = msg.modules.map(function(m) { return '<option value="' + qtEsc(m) + '">'; }).join('');
            if (dlArea && msg.areas) dlArea.innerHTML = msg.areas.map(function(a) { return '<option value="' + qtEsc(a) + '">'; }).join('');
            break;
        case 'qtBrowsedFile':
            if (msg.purpose === 'scope-files') {
                if (!window._qtScopePopupFiles) window._qtScopePopupFiles = [];
                if (window._qtScopePopupFiles.indexOf(msg.path) < 0) {
                    window._qtScopePopupFiles.push(msg.path);
                }
                if (window._qtRenderScopePopupFiles) {
                    window._qtRenderScopePopupFiles();
                } else {
                    var ta = document.getElementById('qt-p-scope-files');
                    if (ta) { ta.value = ta.value ? ta.value + '\\n' + msg.path : msg.path; }
                }
            } else if (msg.purpose === 'ref-path') {
                var inp = document.getElementById('qt-p-ref-path');
                if (inp) inp.value = msg.path;
            }
            break;
        case 'qtUserNameResult':
            if (msg.userName) qtUserName = msg.userName;
            break;
        case 'qtExtAppAvailable':
            var extBtn = document.getElementById('qt-btn-open-ext');
            if (extBtn) extBtn.style.display = msg.available ? '' : 'none';
            break;
        case 'qtTodosForPicker':
            if (msg.questIds) { window._qtPickerQuestList = msg.questIds; }
            if (msg.todos && window._qtTodoPickerCategory) {
                qtUpdateTodoPickerList(msg.todos, window._qtTodoPickerCategory);
                // Update quest dropdown if it was empty and we now have quest list
                var tpQuest = document.getElementById('qt-tp-quest');
                if (tpQuest && tpQuest.options.length === 0 && window._qtPickerQuestList) {
                    window._qtPickerQuestList.forEach(function(q) {
                        var opt = document.createElement('option');
                        opt.value = q;
                        opt.textContent = q;
                        tpQuest.appendChild(opt);
                    });
                }
            }
            break;
        case 'qtTemplates': {
            var templateSel = document.getElementById('qt-template-select');
            if (templateSel) {
                var selected = msg.selected || '__none__';
                templateSel.innerHTML = (msg.templates || []).map(function(t) {
                    return '<option value="' + qtEsc(t.id) + '">' + qtEsc(t.label) + '</option>';
                }).join('');
                templateSel.value = selected;
                if (templateSel.value !== selected) templateSel.value = '__none__';
                qtCurrentTemplate = templateSel.value || '__none__';
            }
            break;
        }
        case 'qtMassCreated':
            if (msg.success) {
                vscode.postMessage({ type: 'qtGetTodos', questId: qtCurrentQuestId, file: qtCurrentFile });
            }
            break;
        case 'qtPendingSelect': {
            var st = msg.state || {};
            var todoId = st.todoId || '';
            var targetFile = st.file || '';
            var targetQuestId = st.questId || '';
            if (todoId) {
                qtPendingSelectTodoId = todoId;
                // Switch quest if specified and different
                if (targetQuestId && targetQuestId !== qtCurrentQuestId) {
                    qtCurrentQuestId = targetQuestId;
                    var qsel0 = document.getElementById('qt-quest-select');
                    if (qsel0) qsel0.value = targetQuestId;
                    // Request updated file list for the new quest
                    vscode.postMessage({ type: 'qtGetFiles', questId: targetQuestId });
                }
                if (targetFile) {
                    qtCurrentFile = targetFile;
                    var fsel0 = document.getElementById('qt-file-select');
                    if (fsel0) fsel0.value = targetFile;
                }
                // Always request a refresh so the pending select gets consumed
                vscode.postMessage({ type: 'qtGetTodos', questId: targetQuestId || qtCurrentQuestId, file: targetFile || qtCurrentFile || 'all' });
            }
            break;
        }
    }
}
`;
}

// ============================================================================
// Backend message handler (for T3 panel integration)
// ============================================================================

/** Handle Quest TODO messages from the webview. Call from T3 panel message handler. */
export async function handleQuestTodoMessage(msg: any, webview: vscode.Webview): Promise<boolean> {
    const post = (m: any) => webview.postMessage(m);
    const cfg = _webviewConfigs.get(webview) || {};

    const isSessionMode = cfg.mode === 'session';
    const isWorkspaceFileMode = cfg.mode === 'workspace-file';
    const isInvalidQuest = cfg.fixedQuestId === '__invalid_quest__';

    const effectiveQuestId = (incoming?: string): string => {
        if (cfg.fixedQuestId) { return cfg.fixedQuestId; }
        return incoming || '';
    };

    const effectiveFile = (incoming?: string): string | undefined => {
        if (cfg.fixedFile) { return cfg.fixedFile; }
        return incoming;
    };

    const workspaceFilePath = (): string | undefined => {
        if (cfg.fixedFilePath) { return cfg.fixedFilePath; }
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) { return undefined; }
        return path.join(wsRoot, 'workspace.todo.yaml');
    };

    switch (msg.type) {
        case 'qtInitConfig':
            _webviewConfigs.set(webview, msg.config || {});
            return true;
        case 'qtSaveState':
            if (msg.state) {
                await _savePanelState(msg.state as QtPanelState);
            }
            return true;
        case 'qtGetState': {
            const saved = _loadPanelState();
            post({ type: 'qtState', state: saved });
            return true;
        }
        case 'qtGetPendingSelect': {
            const pending = _loadPendingSelectState();
            post({ type: 'qtPendingSelect', state: pending });
            return true;
        }
        case 'qtConsumePendingSelect': {
            await _clearPendingSelectState();
            return true;
        }
        case 'qtGetQuests': {
            if (isSessionMode) {
                post({ type: 'qtQuests', quests: ['__session__'], activeQuest: '__session__' });
                return true;
            }
            if (cfg.fixedQuestId) {
                post({ type: 'qtQuests', quests: [cfg.fixedQuestId], activeQuest: cfg.fixedQuestId });
                _sendTodoList(cfg.fixedQuestId, cfg.fixedFile || 'all', post);
                return true;
            }
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            let quests: string[] = [];
            if (wsRoot) {
                const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
                if (fs.existsSync(questsDir)) {
                    quests = fs.readdirSync(questsDir, { withFileTypes: true })
                        .filter(d => d.isDirectory())
                        .map(d => d.name)
                        .sort();
                }
            }
            let activeQuest = '';
            // 1. Check persisted state first
            const saved = _loadPanelState();
            if (saved.questId && quests.indexOf(saved.questId) >= 0) {
                activeQuest = saved.questId;
            }
            // 2. Fall back to ChatVariablesStore
            if (!activeQuest) {
                try { activeQuest = ChatVariablesStore.instance.quest; } catch { /* */ }
            }
            // 3. If no explicit quest, try to infer from the active editor file path
            if (!activeQuest && wsRoot) {
                const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
                if (activeFile) {
                    const questsPrefix = (WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests')) + path.sep;
                    if (activeFile.startsWith(questsPrefix)) {
                        const remainder = activeFile.substring(questsPrefix.length);
                        const slashIdx = remainder.indexOf(path.sep);
                        const inferred = slashIdx > 0 ? remainder.substring(0, slashIdx) : remainder;
                        if (inferred && quests.indexOf(inferred) >= 0) {
                            activeQuest = inferred;
                        }
                    }
                }
            }
            const resolvedQuest = activeQuest || quests[0] || '';
            // Determine the default file — prefer persisted, then primary, then single-file
            let defaultFile = '';
            if (resolvedQuest) {
                const questFiles = questTodo.listTodoFiles(resolvedQuest);
                // Use persisted file if it still exists in this quest
                if (saved.file && saved.file !== 'all' && saved.questId === resolvedQuest && questFiles.indexOf(saved.file) >= 0) {
                    defaultFile = saved.file;
                } else {
                    const primaryName = `todos.${resolvedQuest}.todo.yaml`;
                    if (questFiles.indexOf(primaryName) >= 0) {
                        defaultFile = primaryName;
                    } else if (questFiles.length === 1) {
                        defaultFile = questFiles[0];
                    }
                }
            }
            // Also send persisted sort/filter state to client
            post({ type: 'qtState', state: saved });
            post({ type: 'qtQuests', quests, activeQuest, defaultFile });
            // Also send initial todo list (filtered to default file when available)
            _sendTodoList(resolvedQuest, defaultFile || 'all', post);
            return true;
        }
        case 'qtGetTodos':
            if (isInvalidQuest) {
                post({ type: 'qtTodos', todos: [], questId: '__invalid_quest__', file: cfg.fixedFile || 'all' });
                post({ type: 'qtFiles', files: [], questId: '__invalid_quest__' });
                return true;
            }
            if (isSessionMode) {
                const items = WindowSessionTodoStore.instance.list({ status: 'all' });
                const todos = items.map(t => ({
                    id: t.id,
                    title: t.title,
                    status: t.status === 'done' ? 'completed' : 'not-started',
                    priority: t.priority,
                    tags: t.tags,
                    created: t.createdAt.slice(0, 10),
                    updated: t.updatedAt.slice(0, 10),
                    sourceFile: 'session',
                }));
                post({ type: 'qtTodos', todos, questId: '__session__', file: 'all' });
                post({ type: 'qtFiles', files: ['session'], questId: '__session__' });
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                if (!fp) {
                    post({ type: 'qtTodos', todos: [], questId: '__all_workspace__', file: cfg.fixedFile || 'workspace.todo.yaml' });
                    return true;
                }
                questTodo.ensureTodoFile(fp, { scope: { area: 'workspace' } });
                const items = questTodo.readTodoFile(fp);
                const todos = items.map(t => ({
                    id: t.id,
                    title: t.title ?? t.description?.substring(0, 60),
                    status: t.status,
                    priority: t.priority,
                    tags: t.tags,
                    created: t.created,
                    updated: t.updated,
                    sourceFile: path.basename(fp),
                }));
                post({ type: 'qtTodos', todos, questId: '__all_workspace__', file: path.basename(fp) });
                post({ type: 'qtFiles', files: [path.basename(fp)], questId: '__all_workspace__' });
                return true;
            }
            if (cfg.mode === 'fixed-file' && cfg.fixedQuestId && cfg.fixedFile) {
                const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (wsRoot) {
                    const fp = WsPaths.ai('quests', cfg.fixedQuestId, cfg.fixedFile) || path.join(wsRoot, '_ai', 'quests', cfg.fixedQuestId, cfg.fixedFile);
                    questTodo.ensureTodoFile(fp, { quest: cfg.fixedQuestId });
                }
            }
            _sendTodoList(effectiveQuestId(msg.questId), effectiveFile(msg.file), post);
            return true;
        case 'qtGetTodo':
            // When viewing backup, read from backup file instead of normal file
            if (msg.fromBackup) {
                const bkPath = _resolveBackupPath(isSessionMode, isWorkspaceFileMode, msg.questId, msg.file, workspaceFilePath, cfg);
                if (bkPath && fs.existsSync(bkPath)) {
                    const todo = questTodo.findTodoByIdInFile(bkPath, msg.todoId);
                    post({ type: 'qtTodoDetail', todo: todo ? { ...todo } : null, questId: msg.questId, todoId: msg.todoId });
                } else {
                    post({ type: 'qtTodoDetail', todo: null, questId: msg.questId, todoId: msg.todoId });
                }
                return true;
            }
            if (isSessionMode) {
                const item = WindowSessionTodoStore.instance.get(msg.todoId);
                if (!item) {
                    post({ type: 'qtTodoDetail', todo: null, questId: '__session__', todoId: msg.todoId });
                    return true;
                }
                post({
                    type: 'qtTodoDetail',
                    todo: {
                        id: item.id,
                        title: item.title,
                        description: item.details || '',
                        status: item.status === 'done' ? 'completed' : 'not-started',
                        priority: item.priority,
                        tags: item.tags,
                        created: item.createdAt.slice(0, 10),
                        updated: item.updatedAt.slice(0, 10),
                    },
                    questId: '__session__',
                    todoId: msg.todoId,
                });
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                const todo = fp ? questTodo.findTodoByIdInFile(fp, msg.todoId) : undefined;
                post({ type: 'qtTodoDetail', todo: todo ? { ...todo } : null, questId: '__all_workspace__', todoId: msg.todoId });
                return true;
            }
            _sendTodoDetail(effectiveQuestId(msg.questId), msg.todoId, post);
            return true;
        case 'qtSaveTodo':
            if (isSessionMode) {
                const nextStatus = msg.updates?.status;
                const updated = WindowSessionTodoStore.instance.update(msg.todoId, {
                    title: msg.updates?.title,
                    details: msg.updates?.description,
                    priority: msg.updates?.priority,
                    status: nextStatus === 'completed' || nextStatus === 'cancelled' ? 'done' : undefined,
                });
                post({ type: 'qtSaved', success: !!updated, todoId: msg.todoId });
                const refresh = WindowSessionTodoStore.instance.list({ status: 'all' }).map(t => ({
                    id: t.id,
                    title: t.title,
                    status: t.status === 'done' ? 'completed' : 'not-started',
                    priority: t.priority,
                    tags: t.tags,
                    created: t.createdAt.slice(0, 10),
                    updated: t.updatedAt.slice(0, 10),
                    sourceFile: 'session',
                }));
                post({ type: 'qtTodos', todos: refresh, questId: '__session__', file: 'all' });
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                const updated = fp ? questTodo.updateTodoInFile(fp, msg.todoId, msg.updates) : undefined;
                post({ type: 'qtSaved', success: !!updated, todoId: msg.todoId });
                if (fp) {
                    const items = questTodo.readTodoFile(fp).map(t => ({
                        id: t.id,
                        title: t.title ?? t.description?.substring(0, 60),
                        status: t.status,
                        priority: t.priority,
                        tags: t.tags,
                        created: t.created,
                        updated: t.updated,
                        sourceFile: path.basename(fp),
                    }));
                    post({ type: 'qtTodos', todos: items, questId: '__all_workspace__', file: path.basename(fp) });
                }
                return true;
            }
            _saveTodo(effectiveQuestId(msg.questId), msg.todoId, msg.updates, post);
            return true;
        case 'qtCreateTodo':
            if (isSessionMode) {
                const created = WindowSessionTodoStore.instance.add(msg.todo?.title || msg.todo?.id || 'todo', 'copilot', {
                    details: msg.todo?.description || '',
                    priority: msg.todo?.priority || 'medium',
                    tags: msg.todo?.tags || [],
                });
                if (msg.todo?.status === 'completed' || msg.todo?.status === 'cancelled') {
                    WindowSessionTodoStore.instance.update(created.id, { status: 'done' });
                }
                post({ type: 'qtCreated', success: true, todo: { id: created.id, title: created.title, description: created.details || '', status: created.status === 'done' ? 'completed' : 'not-started', priority: created.priority, tags: created.tags } });
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                if (!fp) {
                    post({ type: 'qtCreated', success: false, error: 'No workspace root' });
                    return true;
                }
                const created = questTodo.createTodoInFile(fp, msg.todo, { scope: { area: 'workspace' } });
                post({ type: 'qtCreated', success: true, todo: created });
                return true;
            }
            _createTodo(effectiveQuestId(msg.questId), msg.todo, effectiveFile(msg.file), post);
            return true;
        case 'qtDeleteTodo':
            // Permanent delete from backup file (no further backup)
            if (msg.fromBackup) {
                const confirmBk = await vscode.window.showWarningMessage(
                    `Permanently delete todo "${msg.todoId}" from backup?`, { modal: true }, 'Delete',
                );
                if (confirmBk !== 'Delete') return true;
                const bkPath = _resolveBackupPath(isSessionMode, isWorkspaceFileMode, msg.questId, msg.file, workspaceFilePath, cfg);
                if (bkPath && fs.existsSync(bkPath)) {
                    const okBk = questTodo.deleteTodo('__backup__', msg.todoId, bkPath);
                    post({ type: 'qtDeleted', success: okBk, todoId: msg.todoId });
                } else {
                    post({ type: 'qtDeleted', success: false, todoId: msg.todoId });
                }
                return true;
            }
            if (isSessionMode) {
                const confirmSess = await vscode.window.showWarningMessage(
                    `Delete todo "${msg.todoId}" from session?`, { modal: true }, 'Delete',
                );
                if (confirmSess !== 'Delete') return true;
                // Backup the todo before deleting
                try {
                    const sessionFp = WindowSessionTodoStore.instance.filePath;
                    _moveToBackup(sessionFp, msg.todoId);
                } catch { /* best-effort backup */ }
                const ok = WindowSessionTodoStore.instance.delete(msg.todoId);
                post({ type: 'qtDeleted', success: ok, todoId: msg.todoId });
                return true;
            }
            if (isWorkspaceFileMode) {
                const confirmWs = await vscode.window.showWarningMessage(
                    `Delete todo "${msg.todoId}" from workspace?`, { modal: true }, 'Delete',
                );
                if (confirmWs !== 'Delete') return true;
                const fp = workspaceFilePath();
                if (fp) {
                    _moveToBackup(fp, msg.todoId);
                }
                const okWs = fp ? questTodo.deleteTodo('__all_workspace__', msg.todoId, fp) : false;
                post({ type: 'qtDeleted', success: okWs, todoId: msg.todoId });
                return true;
            }
            await _deleteTodo(effectiveQuestId(msg.questId), msg.todoId, post, msg.sourceFile);
            return true;
        case 'qtMassCreate': {
            const todos = Array.isArray(msg.todos) ? msg.todos : [];
            let created = 0;
            if (isSessionMode) {
                for (const t of todos) {
                    try {
                        WindowSessionTodoStore.instance.add(t.title || t.id, 'copilot', {
                            details: t.description || '',
                            priority: t.priority || 'medium',
                            tags: t.tags || [],
                        });
                        created++;
                    } catch { /* skip */ }
                }
            } else if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                if (fp) {
                    for (const t of todos) {
                        try {
                            questTodo.createTodoInFile(fp, t, { scope: { area: 'workspace' } });
                            created++;
                        } catch { /* skip */ }
                    }
                }
            } else {
                const qid = effectiveQuestId(msg.questId);
                const file = effectiveFile(msg.file);
                for (const t of todos) {
                    try {
                        questTodo.createTodo(qid, t, file);
                        created++;
                    } catch { /* skip */ }
                }
            }
            post({ type: 'qtMassCreated', success: true, count: created });
            vscode.window.showInformationMessage(`Created ${created} todo(s).`);
            return true;
        }
        case 'qtReopenTodo': {
            // When reopening from backup, update in the backup file and re-send backup todos
            if (msg.fromBackup) {
                const bkPath = _resolveBackupPath(isSessionMode, isWorkspaceFileMode, msg.questId, msg.file, workspaceFilePath, cfg);
                if (bkPath && fs.existsSync(bkPath)) {
                    questTodo.updateTodoInFile(bkPath, msg.todoId, { status: 'not-started', completed_date: '', completed_by: '' });
                    // Re-send backup todo list
                    const items = questTodo.readTodoFile(bkPath).map(t => ({
                        id: t.id, title: t.title ?? (t as any).description?.substring(0, 60),
                        status: t.status, priority: t.priority, tags: t.tags,
                        created: t.created, updated: t.updated,
                        deleted_date: (t as any).deleted_date,
                        sourceFile: path.basename(bkPath),
                    }));
                    post({ type: 'qtTodos', todos: items, questId: msg.questId || '__backup__', file: path.basename(bkPath), fromBackup: true });
                    // Refresh detail
                    const rTodo = questTodo.findTodoByIdInFile(bkPath, msg.todoId);
                    if (rTodo) {
                        post({ type: 'qtTodoDetail', todo: { ...rTodo }, questId: msg.questId, todoId: msg.todoId });
                    }
                }
                return true;
            }
            if (isSessionMode) {
                WindowSessionTodoStore.instance.update(msg.todoId, { status: 'pending' });
                const items = WindowSessionTodoStore.instance.list({ status: 'all' }).map(t => ({
                    id: t.id, title: t.title,
                    status: t.status === 'done' ? 'completed' : 'not-started',
                    priority: t.priority, tags: t.tags,
                    created: t.createdAt.slice(0, 10), updated: t.updatedAt.slice(0, 10),
                    sourceFile: 'session',
                }));
                post({ type: 'qtTodos', todos: items, questId: '__session__', file: 'all' });
                // Also refresh the detail view if this todo was selected
                const rItem = WindowSessionTodoStore.instance.get(msg.todoId);
                if (rItem) {
                    post({ type: 'qtTodoDetail', todo: {
                        id: rItem.id, title: rItem.title,
                        description: rItem.details || '',
                        status: rItem.status === 'done' ? 'completed' : 'not-started',
                        priority: rItem.priority, tags: rItem.tags,
                        created: rItem.createdAt.slice(0, 10), updated: rItem.updatedAt.slice(0, 10),
                    }, questId: '__session__', todoId: msg.todoId });
                }
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                if (fp) {
                    questTodo.updateTodoInFile(fp, msg.todoId, { status: 'not-started', completed_date: '', completed_by: '' });
                    const items = questTodo.readTodoFile(fp).map(t => ({
                        id: t.id, title: t.title ?? t.description?.substring(0, 60),
                        status: t.status, priority: t.priority, tags: t.tags,
                        created: t.created, updated: t.updated,
                        sourceFile: path.basename(fp),
                    }));
                    post({ type: 'qtTodos', todos: items, questId: '__all_workspace__', file: path.basename(fp) });
                    // Refresh detail view
                    const rTodo = questTodo.findTodoByIdInFile(fp, msg.todoId);
                    if (rTodo) {
                        post({ type: 'qtTodoDetail', todo: { ...rTodo }, questId: '__all_workspace__', todoId: msg.todoId });
                    }
                }
                return true;
            }
            const reqId = effectiveQuestId(msg.questId);
            questTodo.updateTodo(reqId, msg.todoId, { status: 'not-started', completed_date: '', completed_by: '' });
            _sendTodoList(reqId, undefined, post);
            // Refresh detail view for quest mode
            _sendTodoDetail(reqId, msg.todoId, post);
            return true;
        }
        case 'qtImportFromFile':
        case 'qtImportSessionFile': {
            // Open file picker for *.todo.yaml, import todos into current panel's target
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRoot) return true;
            // Determine default directory for the file picker
            let importDefaultDir = wsRoot;
            if (isSessionMode) {
                const sessionQid = WindowSessionTodoStore.instance.sessionQuestId;
                const questDir = WsPaths.ai('quests', sessionQid) || path.join(wsRoot, '_ai', 'quests', sessionQid);
                if (fs.existsSync(questDir)) { importDefaultDir = questDir; }
            } else if (!isWorkspaceFileMode) {
                const qid = effectiveQuestId(msg.questId);
                if (qid && !qid.startsWith('__')) {
                    const questDir = WsPaths.ai('quests', qid) || path.join(wsRoot, '_ai', 'quests', qid);
                    if (fs.existsSync(questDir)) { importDefaultDir = questDir; }
                }
            }
            const defaultUri = vscode.Uri.file(importDefaultDir);
            const uris = await vscode.window.showOpenDialog({
                defaultUri,
                filters: { 'Todo YAML': ['yaml'] },
                canSelectMany: false,
                openLabel: 'Import',
            });
            if (!uris || !uris.length) return true;
            const importPath = uris[0].fsPath;
            try {
                const items = questTodo.readTodoFile(importPath);
                let imported = 0;
                if (isSessionMode) {
                    for (const t of items) {
                        try {
                            WindowSessionTodoStore.instance.add(t.title || t.id, 'copilot', {
                                details: t.description || '',
                                priority: t.priority || 'medium',
                                tags: t.tags || [],
                            });
                            imported++;
                        } catch { /* skip */ }
                    }
                    vscode.window.showInformationMessage(`Imported ${imported} todo(s) from ${path.basename(importPath)}.`);
                    const refresh = WindowSessionTodoStore.instance.list({ status: 'all' }).map(t => ({
                        id: t.id, title: t.title,
                        status: t.status === 'done' ? 'completed' : 'not-started',
                        priority: t.priority, tags: t.tags,
                        created: t.createdAt.slice(0, 10), updated: t.updatedAt.slice(0, 10),
                        sourceFile: 'session',
                    }));
                    post({ type: 'qtTodos', todos: refresh, questId: '__session__', file: 'all' });
                } else if (isWorkspaceFileMode) {
                    const fp = workspaceFilePath();
                    if (fp) {
                        for (const t of items) {
                            try {
                                questTodo.createTodoInFile(fp, t, { scope: { area: 'workspace' } });
                                imported++;
                            } catch { /* skip */ }
                        }
                        vscode.window.showInformationMessage(`Imported ${imported} todo(s) from ${path.basename(importPath)}.`);
                        const refreshItems = questTodo.readTodoFile(fp).map(t => ({
                            id: t.id, title: t.title ?? t.description?.substring(0, 60),
                            status: t.status, priority: t.priority, tags: t.tags,
                            created: t.created, updated: t.updated,
                            sourceFile: path.basename(fp),
                        }));
                        post({ type: 'qtTodos', todos: refreshItems, questId: '__all_workspace__', file: path.basename(fp) });
                    }
                } else {
                    // Quest mode — import into current quest/file
                    const qid = effectiveQuestId(msg.questId);
                    const file = effectiveFile(msg.file);
                    for (const t of items) {
                        try {
                            questTodo.createTodo(qid, t, file);
                            imported++;
                        } catch { /* skip */ }
                    }
                    vscode.window.showInformationMessage(`Imported ${imported} todo(s) from ${path.basename(importPath)}.`);
                    _sendTodoList(qid, file, post);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Import failed: ${err.message ?? err}`);
            }
            return true;
        }
        case 'qtConfirmStatusUpdate': {
            const status = String(msg.status || '');
            const answer = await vscode.window.showWarningMessage(
                `Set status to "${status}" and set completion date/by?`,
                { modal: true },
                'Set',
                'Cancel',
            );
            post({ type: 'qtStatusConfirmResult', confirmed: answer === 'Set', status });
            return true;
        }
        case 'qtMoveTodo':
            _moveTodo(msg.questId, msg.todoId, msg.targetFile, post);
            return true;
        case 'qtMoveToWorkspace':
            _moveToWorkspace(msg.questId, msg.todoId, post);
            return true;
        case 'qtRestoreFromBackup': {
            // Move a todo from the backup file back to the corresponding normal todo file
            const bkPath = _resolveBackupPath(isSessionMode, isWorkspaceFileMode, msg.questId, msg.file, workspaceFilePath, cfg);
            if (!bkPath || !fs.existsSync(bkPath)) {
                post({ type: 'qtRestored', success: false, todoId: msg.todoId });
                return true;
            }
            const todoToRestore = questTodo.findTodoByIdInFile(bkPath, msg.todoId);
            if (!todoToRestore) {
                post({ type: 'qtRestored', success: false, todoId: msg.todoId });
                return true;
            }
            try {
                // Prepare the todo data (clean backup-specific fields)
                const todoData: Record<string, unknown> = { ...todoToRestore };
                delete todoData._sourceFile;
                delete (todoData as any).deleted_date;
                todoData.updated = new Date().toISOString().slice(0, 10);
                // Restore into the appropriate normal file
                if (isSessionMode) {
                    WindowSessionTodoStore.instance.add(String(todoData.title || todoData.id), 'user', {
                        details: String(todoData.description || ''),
                        priority: (todoData.priority as 'low' | 'medium' | 'high' | 'critical') || 'medium',
                        tags: Array.isArray(todoData.tags) ? todoData.tags : [],
                    });
                } else if (isWorkspaceFileMode) {
                    const fp = workspaceFilePath();
                    if (fp) {
                        questTodo.createTodoInFile(fp, todoData as any, { scope: { area: 'workspace' } });
                    }
                } else {
                    const qid = effectiveQuestId(msg.questId);
                    const file = effectiveFile(msg.file);
                    questTodo.createTodo(qid, todoData as any, file);
                }
                // Remove from backup
                questTodo.deleteTodo('__backup__', msg.todoId, bkPath);
                // Re-send backup list
                const bkItems = questTodo.readTodoFile(bkPath).map(t => ({
                    id: t.id, title: t.title ?? (t as any).description?.substring(0, 60),
                    status: t.status, priority: t.priority, tags: t.tags,
                    created: t.created, updated: t.updated,
                    deleted_date: (t as any).deleted_date,
                    sourceFile: path.basename(bkPath),
                }));
                post({ type: 'qtTodos', todos: bkItems, questId: msg.questId || '__backup__', file: path.basename(bkPath), fromBackup: true });
                post({ type: 'qtRestored', success: true, todoId: msg.todoId });
                vscode.window.showInformationMessage(`Todo "${msg.todoId}" restored from backup.`);
            } catch (e) {
                console.error('[QuestTodo] qtRestoreFromBackup failed:', e);
                post({ type: 'qtRestored', success: false, todoId: msg.todoId });
            }
            return true;
        }
        case 'qtOpenYaml':
            if (isSessionMode) {
                try {
                    const sessionFp = WindowSessionTodoStore.instance.filePath;
                    if (fs.existsSync(sessionFp)) {
                        const doc = await vscode.workspace.openTextDocument(sessionFp);
                        await vscode.window.showTextDocument(doc);
                    } else {
                        vscode.window.showWarningMessage('Session todo file does not exist yet. Add a todo first.');
                    }
                } catch {
                    vscode.window.showWarningMessage('Session todo store not initialised.');
                }
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                if (fp) {
                    const doc = await vscode.workspace.openTextDocument(fp);
                    await vscode.window.showTextDocument(doc);
                }
                return true;
            }
            _openYamlFile(msg.questId, msg.file);
            return true;
        case 'qtCheckBackupExists': {
            const bkPath = _resolveBackupPath(isSessionMode, isWorkspaceFileMode, msg.questId, msg.file, workspaceFilePath, cfg);
            post({ type: 'qtBackupStatus', exists: !!bkPath && fs.existsSync(bkPath) });
            return true;
        }
        case 'qtGetBackupTodos': {
            const bkPath = _resolveBackupPath(isSessionMode, isWorkspaceFileMode, msg.questId, msg.file, workspaceFilePath, cfg);
            if (!bkPath || !fs.existsSync(bkPath)) {
                post({ type: 'qtTodos', todos: [], questId: msg.questId || '__backup__', file: 'backup', fromBackup: true });
                post({ type: 'qtBackupStatus', exists: false });
                return true;
            }
            const items = questTodo.readTodoFile(bkPath);
            const todos = items.map(t => ({
                id: t.id,
                title: t.title ?? t.description?.substring(0, 60),
                status: t.status,
                priority: t.priority,
                tags: t.tags,
                created: t.created,
                updated: t.updated,
                deleted_date: (t as any).deleted_date,
                sourceFile: path.basename(bkPath),
            }));
            post({ type: 'qtTodos', todos, questId: msg.questId || '__backup__', file: path.basename(bkPath), fromBackup: true });
            return true;
        }
        case 'qtGetFiles':
            if (isSessionMode) {
                post({ type: 'qtFiles', files: ['session'], questId: '__session__' });
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                post({ type: 'qtFiles', files: [path.basename(fp || 'workspace.todo.yaml')], questId: '__all_workspace__' });
                return true;
            }
            _sendFileList(msg.questId, post);
            return true;
        case 'qtGetAllTags': {
            // For session/workspace modes, collect tags from all quests
            const tagQuestId = (msg.questId === '__session__' || msg.questId === '__all_workspace__') ? undefined : (msg.questId || undefined);
            const allTags = collectAllTags(tagQuestId);
            // For session mode, also merge tags from session todos
            if (isSessionMode) {
                const sessionItems = WindowSessionTodoStore.instance.list({ status: 'all' });
                for (const si of sessionItems) {
                    if (si.tags) { for (const tg of si.tags) { if (!allTags.includes(tg)) allTags.push(tg); } }
                }
                allTags.sort();
            }
            post({ type: 'qtAllTags', tags: allTags });
            return true;
        }
        case 'qtGetScopeData': {
            const projs = scanWorkspaceProjects();
            const scopeVals = collectScopeValues();
            // Merge scanned project names with existing scope values
            const projNames = new Set(scopeVals.projects);
            for (const p of projs) projNames.add(p.name);
            post({
                type: 'qtScopeData',
                projects: [...projNames].sort(),
                modules: scopeVals.modules,
                areas: scopeVals.areas,
            });
            return true;
        }
        case 'qtBrowseFile': {
            const wsFolder = vscode.workspace.workspaceFolders?.[0];
            if (!wsFolder) return true;
            const uris = await vscode.window.showOpenDialog({
                defaultUri: wsFolder.uri,
                canSelectMany: msg.purpose === 'scope-files',
                openLabel: 'Select',
            });
            if (uris) {
                for (const uri of uris) {
                    const rel = path.relative(wsFolder.uri.fsPath, uri.fsPath);
                    post({ type: 'qtBrowsedFile', purpose: msg.purpose, path: rel });
                }
            }
            return true;
        }
        case 'qtPickProjects': {
            const projects = scanWorkspaceProjects().map((p) => p.name);
            const selected = Array.isArray(msg.selected) ? msg.selected : [];
            const picked = await vscode.window.showQuickPick(
                projects.map((name) => ({ label: name, picked: selected.includes(name) })),
                {
                    canPickMany: true,
                    placeHolder: 'Select projects',
                    title: 'Scope Projects',
                },
            );
            if (picked) {
                post({ type: 'qtPickedProjects', projects: picked.map((item) => item.label) });
            }
            return true;
        }
        case 'qtPopout':
            _openPopoutPanel();
            return true;
        case 'qtOpenExtApp': {
            // Open the current YAML file in an external application
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRoot || !msg.questId) return true;
            const fileName = (!msg.file || msg.file === 'all') ? `todos.${msg.questId}.todo.yaml` : msg.file;
            const fp = WsPaths.ai('quests', msg.questId, fileName) || path.join(wsRoot, '_ai', 'quests', msg.questId, fileName);
            if (fs.existsSync(fp)) {
                await openInExternalApplication(fp);
            }
            return true;
        }
        case 'qtOpenTrailFiles': {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRoot) return true;
            // Use quest directory when a quest is active, fall back to _ai/trail
            let trailFolder = WsPaths.ai('trail') || path.join(wsRoot, '_ai', 'trail');
            try {
                const activeQuest = ChatVariablesStore.instance.quest;
                if (activeQuest) {
                    const questDir = WsPaths.ai('quests', activeQuest) || path.join(wsRoot, '_ai', 'quests', activeQuest);
                    if (fs.existsSync(questDir)) {
                        trailFolder = questDir;
                    }
                }
            } catch { /* */ }
            if (!fs.existsSync(trailFolder)) {
                fs.mkdirSync(trailFolder, { recursive: true });
            }
            const workspaceName = path.basename(wsRoot).replace(/\s+/g, '_');
            const promptsPath = path.join(trailFolder, `${workspaceName}.prompts.md`);
            if (!fs.existsSync(promptsPath)) {
                fs.writeFileSync(promptsPath, '# Copilot Prompts Trail\n\n', 'utf-8');
            }
            const uri = vscode.Uri.file(promptsPath);
            await vscode.commands.executeCommand('vscode.openWith', uri, 'trailViewer.editor');
            return true;
        }
        case 'qtCheckExtApp': {
            // Check if there's an external app configured for .yaml files
            const wsRootChk = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRootChk) {
                post({ type: 'qtExtAppAvailable', available: false });
                return true;
            }
            const testPath = path.join(wsRootChk, 'test.yaml');
            const extApp = getExternalApplicationForFile(testPath);
            post({ type: 'qtExtAppAvailable', available: !!extApp });
            return true;
        }
        case 'qtGetUserName': {
            const config = loadSendToChatConfig();
            const envOverride = (process.env.TOM_USER ?? '').trim();
            let userName = envOverride;
            if (!userName) {
                let userNameTemplate = config?.userName || '${username}';
                const resolved = resolvePathVariables(userNameTemplate, { silent: true });
                userName = (resolved ?? userNameTemplate ?? '').trim();
                if (!userName || userName === '${username}') {
                    try { userName = require('os').userInfo().username; } catch { /* */ }
                }
            }
            post({ type: 'qtUserNameResult', userName });
            return true;
        }
        case 'qtShowError': {
            const message = String(msg.message || 'Action failed');
            vscode.window.showErrorMessage(message);
            return true;
        }
        case 'qtGetTemplates': {
            const config = loadSendToChatConfig();
            const configured = Object.keys(config?.templates || {})
                .filter((key) => key !== '__answer_file__')
                .sort();
            const templates = [
                { id: '__none__', label: '(None)' },
                ...configured.map((name) => ({ id: name, label: name })),
                { id: '__answer_file__', label: 'Answer Wrapper' },
            ];
            // Use todoPanel.defaultTemplate if set, otherwise fall back to defaultTemplates.copilot
            const todoPanelDefault = config?.todoPanel?.defaultTemplate;
            const defaultTemplate = String(todoPanelDefault || config?.defaultTemplates?.copilot || '__none__');
            const selected = templates.some((t) => t.id === defaultTemplate) ? defaultTemplate : '__none__';
            post({ type: 'qtTemplates', templates, selected });
            return true;
        }
        case 'qtAddCurrentTodoToQueue': {
            const questId = effectiveQuestId(msg.questId);
            const todoId = String(msg.todoId || '');
            if (!todoId) {
                vscode.window.showErrorMessage('Select a todo first.');
                return true;
            }
            const todo = _findTodoForPromptAction(questId, todoId, msg.sourceFile);
            if (!todo) {
                vscode.window.showErrorMessage(`Todo not found: ${todoId}`);
                return true;
            }
            const todoYaml = _todoYamlFragment(todo, questId, msg.sourceFile);
            const wrappedText = applyDefaultTemplate(todoYaml, 'copilot');
            const selectedTemplate = (msg.template && msg.template !== '__none__') ? String(msg.template) : undefined;
            try {
                const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
                const queue = PromptQueueManager.instance;
                await queue.enqueue({
                    originalText: wrappedText,
                    template: selectedTemplate,
                    deferSend: true,
                });
                vscode.window.showInformationMessage(`Added todo ${todoId} to prompt queue`);
            } catch {
                vscode.window.showWarningMessage('Prompt queue not available');
            }
            return true;
        }
        case 'qtSendCurrentTodoToCopilot': {
            const questId = effectiveQuestId(msg.questId);
            const todoId = String(msg.todoId || '');
            if (!todoId) {
                vscode.window.showErrorMessage('Select a todo first.');
                return true;
            }
            const todo = _findTodoForPromptAction(questId, todoId, msg.sourceFile);
            if (!todo) {
                vscode.window.showErrorMessage(`Todo not found: ${todoId}`);
                return true;
            }
            const todoYaml = _todoYamlFragment(todo, questId, msg.sourceFile);
            const todoRef = _extractTodoRefFromYamlFragment(todoYaml) || todoId;
            const todoPrompt = `${todoYaml}\n\nREQUIRED: Add responseValue #TODO=${todoRef}\n\n`;
            const wrappedText = applyDefaultTemplate(todoPrompt, 'copilot');
            const selectedTemplate = String(msg.template || '__none__');
            const config = loadSendToChatConfig();
            const answerFileTemplate = config?.templates?.['__answer_file__']?.template || DEFAULT_ANSWER_FILE_TEMPLATE;

            let expanded: string;
            if (!selectedTemplate || selectedTemplate === '__none__') {
                expanded = await expandTemplate(wrappedText);
            } else if (selectedTemplate === '__answer_file__') {
                expanded = await expandTemplate(answerFileTemplate, { values: { originalPrompt: wrappedText } });
            } else {
                const selectedTemplateText = config?.templates?.[selectedTemplate]?.template;
                if (selectedTemplateText) {
                    const templateExpanded = await expandTemplate(selectedTemplateText, { values: { originalPrompt: wrappedText } });
                    expanded = await expandTemplate(answerFileTemplate, { values: { originalPrompt: templateExpanded } });
                } else {
                    expanded = await expandTemplate(wrappedText);
                }
            }

            await vscode.commands.executeCommand('workbench.action.chat.open', { query: expanded });
            return true;
        }
        case 'qtOpenInEditor': {
            // Open a reference file in the VS Code editor
            if (msg.path) {
                const wsRootRef = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!wsRootRef) return true;
                const absPath = path.isAbsolute(msg.path) ? msg.path : path.join(wsRootRef, msg.path);
                if (fs.existsSync(absPath)) {
                    const doc = await vscode.workspace.openTextDocument(absPath);
                    const editor = await vscode.window.showTextDocument(doc);
                    if (msg.lines) {
                        const match = String(msg.lines).match(/^(\d+)/);
                        if (match) {
                            const line = Math.max(0, parseInt(match[1], 10) - 1);
                            const pos = new vscode.Position(line, 0);
                            editor.selection = new vscode.Selection(pos, pos);
                            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                        }
                    }
                }
            } else if (msg.url) {
                try {
                    await vscode.commands.executeCommand('simpleBrowser.show', msg.url);
                } catch {
                    await vscode.env.openExternal(vscode.Uri.parse(msg.url));
                }
            }
            return true;
        }
        case 'qtOpenRefExtApp': {
            // Open a reference path in external application
            const wsRootExt = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRootExt || !msg.path) return true;
            const absPathExt = path.isAbsolute(msg.path) ? msg.path : path.join(wsRootExt, msg.path);
            if (fs.existsSync(absPathExt)) {
                await openInExternalApplication(absPathExt);
            }
            return true;
        }
        case 'qtGetTodosForPicker': {
            // Return all todos for the current quest for the todo picker
            try {
                let items: questTodo.QuestTodoItem[];
                const source = msg.source || 'local';
                const qid = effectiveQuestId(msg.questId);
                // Session mode: 'local' returns session todos, 'quest' reads specified quest, 'workspace' reads all
                if (isSessionMode && source === 'local') {
                    const sessionItems = WindowSessionTodoStore.instance.list({ status: 'all' });
                    items = sessionItems.map(si => ({
                        id: si.id,
                        title: si.title,
                        description: si.details || '',
                        status: si.status === 'done' ? 'completed' as const : 'not-started' as const,
                        priority: si.priority,
                        tags: si.tags,
                        _sourceFile: 'session',
                    }));
                } else if (source === 'workspace' || qid === '__all_workspace__') {
                    items = readWorkspaceTodos();
                } else if (source === 'quest') {
                    // For session/workspace modes, check if qid is a real quest
                    const realQid = (qid === '__session__' || qid === '__all_workspace__') ? msg.questId : qid;
                    items = realQid && !realQid.startsWith('__') ? questTodo.readAllTodos(realQid) : [];
                } else {
                    if (qid && qid !== '__all_quests__' && qid !== '__all_workspace__' && qid !== '__session__') {
                        items = questTodo.readAllTodos(qid);
                    } else {
                        items = [];
                    }
                }
                const list = items.map(t => {
                    const sourcePath = t._sourceFile || '';
                    let sourceQuest = qid;
                    const wsQuestMatch = sourcePath.match(/^_ai\/quests\/([^/]+)\//);
                    if (wsQuestMatch && wsQuestMatch[1]) {
                        sourceQuest = wsQuestMatch[1];
                    } else {
                        const qMatch = sourcePath.match(/^([^/]+)\//);
                        if (qMatch && qMatch[1]) {
                            sourceQuest = qMatch[1];
                        }
                    }
                    const useQualified = source === 'workspace' || source === 'quest';
                    return {
                        id: t.id,
                        ref: useQualified && sourceQuest ? `${sourceQuest}/${t.id}` : t.id,
                        title: t.title ?? t.description?.substring(0, 60),
                        status: t.status,
                    };
                });
                const questIds = listQuestIds();
                post({ type: 'qtTodosForPicker', todos: list, questIds });
            } catch {
                post({ type: 'qtTodosForPicker', todos: [], questIds: [] });
            }
            return true;
        }
        case 'qtCheckPathExtApps': {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const result: Record<string, boolean> = {};
            if (wsRoot && Array.isArray(msg.paths)) {
                for (const p of msg.paths) {
                    if (!p || typeof p !== 'string') continue;
                    const abs = path.isAbsolute(p) ? p : path.join(wsRoot, p);
                    result[p] = !!getExternalApplicationForFile(abs);
                }
            }
            post({ type: 'qtPathExtAppAvailability', paths: result });
            return true;
        }
    }
    return false;
}

/** Set up a file watcher that calls refreshFn when quest YAML files change. */
export function setupQuestTodoWatcher(refreshFn: () => void): vscode.Disposable | undefined {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) { return undefined; }
    const pattern = new vscode.RelativePattern(wsRoot, WsPaths.questTodoGlob);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(refreshFn);
    watcher.onDidCreate(refreshFn);
    watcher.onDidDelete(refreshFn);
    return watcher;
}

/** Send the full todo list refresh to the webview */
export function sendQuestTodoRefresh(webview: vscode.Webview): void {
    let activeQuest = '';
    try { activeQuest = ChatVariablesStore.instance.quest; } catch { /* */ }
    if (!activeQuest) return;
    const post = (m: any) => webview.postMessage(m);
    _sendTodoList(activeQuest, 'all', post);
}

// ============================================================================
// Data helpers (shared between standalone and embedded modes)
// ============================================================================

function _sendFileList(questId: string, post: (m: any) => void): void {
    if (!questId) return;
    try {
        let files: string[];
        if (questId === '__all_workspace__') {
            files = listWorkspaceTodoFiles();
        } else if (questId === '__all_quests__') {
            // For all-quests, show quest IDs as pseudo-files
            files = listQuestIds().map(q => q + '/');
        } else {
            files = questTodo.listTodoFiles(questId);
        }
        post({ type: 'qtFiles', files, questId });
    } catch { /* quest folder may not exist */ }
}

function _sendTodoList(questId: string, file: string | undefined, post: (m: any) => void): void {
    if (!questId) return;
    try {
        let items: questTodo.QuestTodoItem[];
        if (questId === '__all_quests__') {
            items = readAllQuestsTodos();
        } else if (questId === '__all_workspace__') {
            items = readWorkspaceTodos();
        } else if (file && file !== 'all') {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const fp = WsPaths.ai('quests', questId, file) || path.join(wsRoot, '_ai', 'quests', questId, file);
            items = questTodo.readTodoFile(fp);
        } else {
            items = questTodo.readAllTodos(questId);
        }
        const list = items.map(t => ({
            id: t.id,
            title: t.title ?? t.description?.substring(0, 60),
            status: t.status,
            priority: t.priority,
            tags: t.tags,
            created: t.created,
            updated: t.updated,
            sourceFile: t._sourceFile,
        }));
        post({ type: 'qtTodos', todos: list, questId, file: file ?? 'all' });
        _sendFileList(questId, post);
    } catch { /* */ }
}

function _sendTodoDetail(questId: string, todoId: string, post: (m: any) => void): void {
    let todo: questTodo.QuestTodoItem | undefined;
    let resolvedQuestId = questId;
    if (questId === '__all_quests__') {
        // Search across all quests
        for (const qid of listQuestIds()) {
            todo = questTodo.findTodoById(qid, todoId);
            if (todo) { resolvedQuestId = qid; break; }
        }
    } else if (questId === '__all_workspace__') {
        // Search across all workspace todo files
        const all = readWorkspaceTodos();
        todo = all.find(t => t.id === todoId);
        // Try to resolve the quest id from the source path
        if (todo?._sourceFile) {
            const m = todo._sourceFile.match(/^_ai\/quests\/([^/]+)\//);
            if (m) resolvedQuestId = m[1];
        }
    } else {
        todo = questTodo.findTodoById(questId, todoId);
    }
    const payload: any = todo ? { ...todo } : null;
    if (payload && resolvedQuestId !== questId) { payload._resolvedQuestId = resolvedQuestId; }
    post({ type: 'qtTodoDetail', todo: payload, questId, todoId });
}

function _saveTodo(questId: string, todoId: string, updates: any, post: (m: any) => void): void {
    const current = questTodo.findTodoById(questId, todoId);
    if (current) {
        const normalize = (v: any) => v === undefined ? null : v;
        const same =
            normalize(current.title) === normalize(updates.title) &&
            normalize(current.status) === normalize(updates.status) &&
            normalize(current.priority) === normalize(updates.priority) &&
            normalize(current.description) === normalize(updates.description) &&
            JSON.stringify(normalize(current.tags)) === JSON.stringify(normalize(updates.tags)) &&
            JSON.stringify(normalize(current.dependencies)) === JSON.stringify(normalize(updates.dependencies)) &&
            JSON.stringify(normalize(current.blocked_by)) === JSON.stringify(normalize(updates.blocked_by)) &&
            normalize(current.notes) === normalize(updates.notes) &&
            JSON.stringify(normalize(current.scope)) === JSON.stringify(normalize(updates.scope)) &&
            JSON.stringify(normalize(current.references)) === JSON.stringify(normalize(updates.references)) &&
            normalize(current.completed_date) === normalize(updates.completed_date) &&
            normalize(current.completed_by) === normalize(updates.completed_by);
        if (same) {
            post({ type: 'qtSaved', success: true, todoId });
            return;
        }
    }
    const updated = questTodo.updateTodo(questId, todoId, updates);
    post({ type: 'qtSaved', success: !!updated, todoId });
    if (updated) _sendTodoList(questId, undefined, post);
}

function _createTodo(questId: string, todo: any, file: string | undefined, post: (m: any) => void): void {
    try {
        const created = questTodo.createTodo(questId, todo, file);
        post({ type: 'qtCreated', success: true, todo: created });
        _sendTodoList(questId, undefined, post);
    } catch (err: any) {
        post({ type: 'qtCreated', success: false, error: err.message ?? String(err) });
    }
}

/** Resolve the backup file path for the current panel context. */
function _resolveBackupPath(
    isSessionMode: boolean,
    isWorkspaceFileMode: boolean,
    questId: string | undefined,
    file: string | undefined,
    workspaceFilePath: () => string | undefined,
    cfg: Record<string, any>,
): string | undefined {
    try {
        if (isSessionMode) {
            const sessionFp = WindowSessionTodoStore.instance.filePath;
            return sessionFp.replace(/\.todo\.yaml$/, '.backup.todo.yaml');
        }
        if (isWorkspaceFileMode) {
            const fp = workspaceFilePath();
            if (!fp) return undefined;
            return fp.replace(/\.todo\.yaml$/, '.backup.todo.yaml');
        }
        // Quest mode — resolve from quest folder
        const qid = cfg.fixedQuestId || questId;
        if (!qid) return undefined;
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) return undefined;
        const folder = WsPaths.ai('quests', qid) || path.join(wsRoot, '_ai', 'quests', qid);
        const fileName = (!file || file === 'all')
            ? `todos.${qid}.todo.yaml`
            : file;
        const base = path.basename(fileName);
        const backupName = base.replace(/\.todo\.yaml$/, '.backup.todo.yaml');
        return path.join(folder, backupName);
    } catch {
        return undefined;
    }
}

async function _deleteTodo(questId: string, todoId: string, post: (m: any) => void, sourceFile?: string): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
        `Delete todo "${todoId}" from quest "${questId}"?`,
        { modal: true },
        'Delete',
    );
    if (answer !== 'Delete') return;
    // Move to backup before deleting
    _moveToBackupByTodo(questId, todoId, sourceFile);
    const deleted = questTodo.deleteTodo(questId, todoId, sourceFile);
    post({ type: 'qtDeleted', success: !!deleted, todoId });
    _sendTodoList(questId, undefined, post);
}

/** Move a todo to the backup file before deletion. */
function _moveToBackupByTodo(questId: string, todoId: string, sourceFile?: string): void {
    try {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) return;
        // Try to resolve source file: could be absolute, relative, or just basename
        if (sourceFile) {
            const candidates: string[] = [];
            if (path.isAbsolute(sourceFile)) {
                candidates.push(sourceFile);
            } else {
                // Try as workspace-relative path
                candidates.push(path.join(wsRoot, sourceFile));
                // Try within quest folder if questId is valid
                if (questId && !questId.startsWith('__')) {
                    const folder = WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);
                    candidates.push(path.join(folder, sourceFile));
                }
                // Try as _ai/quests/questId/sourceFile (sourceFile may include quest path prefix)
                if (sourceFile.includes('/')) {
                    candidates.push(path.join(wsRoot, '_ai', 'quests', sourceFile));
                }
            }
            for (const absSource of candidates) {
                if (fs.existsSync(absSource)) {
                    const todo = questTodo.findTodoByIdInFile(absSource, todoId);
                    if (todo) {
                        _moveToBackup(absSource, todoId);
                        return;
                    }
                }
            }
        }
        // Fallback: scan all quest files
        if (questId && !questId.startsWith('__')) {
            const folder = WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);
            for (const fileName of questTodo.listTodoFiles(questId)) {
                const fp = path.join(folder, fileName);
                const todo = questTodo.findTodoByIdInFile(fp, todoId);
                if (todo) {
                    _moveToBackup(fp, todoId);
                    return;
                }
            }
        }
    } catch (e) {
        console.error('[QuestTodo] _moveToBackupByTodo failed:', e);
    }
}

/** Copy a todo to the backup variant of the given file. */
function _moveToBackup(filePath: string, todoId: string): void {
    try {
        const todo = questTodo.findTodoByIdInFile(filePath, todoId);
        if (!todo) {
            console.warn(`[QuestTodo] _moveToBackup: todo ${todoId} not found in ${filePath}`);
            return;
        }
        const dir = path.dirname(filePath);
        const base = path.basename(filePath);
        // workspace.todo.yaml => workspace.backup.todo.yaml
        // todos.quest.todo.yaml => todos.quest.backup.todo.yaml
        const backupName = base.replace(/\.todo\.yaml$/, '.backup.todo.yaml');
        const backupPath = path.join(dir, backupName);
        // Create backup file if needed
        const header: Record<string, unknown> = {};
        if (base.startsWith('workspace')) {
            header.scope = { area: 'workspace' };
        }
        questTodo.ensureTodoFile(backupPath, header);
        // Copy the todo data into backup
        const todoData: Record<string, unknown> = { ...todo };
        delete todoData._sourceFile;
        todoData.status = todoData.status || 'cancelled';
        todoData.deleted_date = new Date().toISOString().slice(0, 10);
        todoData.updated = new Date().toISOString().slice(0, 10);
        questTodo.createTodoInFile(backupPath, todoData as any, header);
        console.log(`[QuestTodo] Backed up todo ${todoId} to ${backupPath}`);
    } catch (e) {
        console.error(`[QuestTodo] _moveToBackup failed for ${todoId} in ${filePath}:`, e);
    }
}

function _moveTodo(questId: string, todoId: string, targetFile: string, post: (m: any) => void): void {
    const moved = questTodo.moveTodo(questId, todoId, targetFile);
    post({ type: 'qtMoved', success: !!moved, todoId });
    _sendTodoList(questId, undefined, post);
}

function _moveToWorkspace(questId: string, todoId: string, post: (m: any) => void): void {
    // Resolve the actual quest ID when in aggregated modes
    let resolvedQuestId = questId;
    if (questId === '__all_quests__') {
        for (const qid of listQuestIds()) {
            const found = questTodo.findTodoById(qid, todoId);
            if (found) { resolvedQuestId = qid; break; }
        }
    } else if (questId === '__all_workspace__') {
        // Workspace todos are already "workspace-level" — nothing to move
        const all = readWorkspaceTodos();
        const todo = all.find(t => t.id === todoId);
        if (todo?._sourceFile) {
            const m = todo._sourceFile.match(/^_ai\/quests\/([^/]+)\//);
            if (m) resolvedQuestId = m[1];
        }
    }
    const moved = questTodo.moveToWorkspaceTodo(resolvedQuestId, todoId);
    post({ type: 'qtMoved', success: !!moved, todoId });
    _sendTodoList(questId, undefined, post);
}

function _openYamlFile(questId: string, file: string): void {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot || !questId) return;
    // If 'all' selected, open the main quest todo file
    const fileName = (!file || file === 'all') ? `todos.${questId}.todo.yaml` : file;
    const fp = WsPaths.ai('quests', questId, fileName) || path.join(wsRoot, '_ai', 'quests', questId, fileName);
    if (fs.existsSync(fp)) {
        vscode.workspace.openTextDocument(fp).then(doc => vscode.window.showTextDocument(doc));
    } else {
        vscode.window.showWarningMessage(`File not found: ${fileName}`);
    }
}

function _todoYamlFragment(todo: questTodo.QuestTodoItem, questId?: string, sourceFileHint?: string): string {
    const sourcePath = _resolveTodoSourcePath(todo, questId, sourceFileHint);
    const qualifiedId = sourcePath ? `${sourcePath}/${todo.id}` : todo.id;
    const clean: Record<string, unknown> = {
        id: qualifiedId,
        title: todo.title,
        description: todo.description,
        status: todo.status,
        priority: todo.priority,
        tags: todo.tags,
        dependencies: todo.dependencies,
        blocked_by: todo.blocked_by,
        notes: todo.notes,
        scope: todo.scope,
        references: todo.references,
        created: todo.created,
        updated: todo.updated,
        completed_date: todo.completed_date,
        completed_by: todo.completed_by,
    };
    Object.keys(clean).forEach((key) => {
        if (clean[key] === undefined || clean[key] === null || clean[key] === '') {
            delete clean[key];
        }
    });
    return yaml.stringify([clean]).trim();
}

function _extractTodoRefFromYamlFragment(todoYaml: string): string | undefined {
    const m = todoYaml.match(/(?:^|\n)-\s*id:\s*([^\n]+)/);
    if (!m?.[1]) return undefined;
    const value = m[1].trim().replace(/^['"]|['"]$/g, '');
    return value || undefined;
}

function _resolveTodoSourcePath(todo: questTodo.QuestTodoItem, questId?: string, sourceFileHint?: string): string | undefined {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const normalize = (p: string): string => p.replace(/\\/g, '/');
    const normalizeRel = (p: string): string => normalize(p).replace(/^\.\//, '');

    const hinted = sourceFileHint || todo._sourceFile;
    if (hinted && wsRoot) {
        const abs = path.isAbsolute(hinted) ? hinted : path.join(wsRoot, hinted);
        const rel = normalizeRel(path.relative(wsRoot, abs));
        const hintedNorm = normalizeRel(hinted);
        const hintedLooksRelativePath = hintedNorm.includes('/');
        if (!rel.startsWith('..') && rel !== '' && (hintedLooksRelativePath || fs.existsSync(abs))) return rel;
    }

    const sf = todo._sourceFile ? normalizeRel(todo._sourceFile) : '';
    if (!sf) return undefined;
    if (sf.endsWith('.todo.yaml') && sf.includes('/')) return sf;
    if (questId && questId !== '__all_quests__' && questId !== '__all_workspace__') {
        return normalizeRel(path.join('_ai', 'quests', questId, sf));
    }
    if (questId === '__all_quests__' && sf.includes('/')) {
        return normalizeRel(path.join('_ai', 'quests', sf));
    }
    return sf;
}

function _findTodoForPromptAction(questId: string, todoId: string, sourceFile?: string): questTodo.QuestTodoItem | undefined {
    if (!questId || !todoId) return undefined;

    if (questId === '__all_quests__') {
        if (sourceFile) {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (wsRoot) {
                const absSource = path.isAbsolute(sourceFile) ? sourceFile : path.join(wsRoot, sourceFile);
                if (fs.existsSync(absSource)) {
                    return questTodo.findTodoByIdInFile(absSource, todoId);
                }
            }
        }
        for (const qid of listQuestIds()) {
            const found = questTodo.findTodoById(qid, todoId);
            if (found) return found;
        }
        return undefined;
    }

    if (questId === '__all_workspace__') {
        if (sourceFile) {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (wsRoot) {
                const absSource = path.isAbsolute(sourceFile) ? sourceFile : path.join(wsRoot, sourceFile);
                if (fs.existsSync(absSource)) {
                    return questTodo.findTodoByIdInFile(absSource, todoId);
                }
            }
        }
        return readWorkspaceTodos().find((t) => t.id === todoId);
    }

    if (sourceFile) {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wsRoot) {
            const absSource = path.isAbsolute(sourceFile) ? sourceFile : path.join(wsRoot, sourceFile);
            if (fs.existsSync(absSource)) {
                const inFile = questTodo.findTodoByIdInFile(absSource, todoId);
                if (inFile) return inFile;
            }
        }
    }

    return questTodo.findTodoById(questId, todoId);
}

// ============================================================================
// Popout panel — opens the same TODO editor in a full editor tab
// ============================================================================

function _openPopoutPanel(): void {
    if (_popoutPanel) {
        _popoutPanel.reveal();
        return;
    }
    const ctx = _extensionContext;
    if (!ctx) return;

    const codiconsUri = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');

    _popoutPanel = vscode.window.createWebviewPanel(
        'questTodoEditor',
        'Quest TODO Editor',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        },
    );

    const webviewCodiconsUri = _popoutPanel.webview.asWebviewUri(codiconsUri);
    _popoutPanel.webview.html = _getPopoutHtml(webviewCodiconsUri.toString());

    _popoutPanel.webview.onDidReceiveMessage(
        async (message) => {
            await handleQuestTodoMessage(message, _popoutPanel!.webview);
        },
        undefined,
        ctx.subscriptions,
    );

    // File watcher for auto-refresh
    const watcher = setupQuestTodoWatcher(() => {
        if (_popoutPanel) sendQuestTodoRefresh(_popoutPanel.webview);
    });

    _popoutPanel.onDidDispose(() => {
        _popoutPanel = undefined;
        watcher?.dispose();
    });
}

function _getPopoutHtml(codiconsUri: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconsUri}">
<style>
body { margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
${getQuestTodoCss()}
</style>
</head>
<body>
${getQuestTodoHtmlFragment()}
<script>
const vscode = acquireVsCodeApi();
window.addEventListener('message', function(event) { qtHandleMessage(event.data); });
${getQuestTodoScript()}
</script>
</body>
</html>`;
}

function _getEmbeddedQuestTodoHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    config?: QuestTodoViewConfig,
): string {
    const codiconsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconsUri}">
<style>
body { margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
${getQuestTodoCss()}
</style>
</head>
<body>
${getQuestTodoHtmlFragment(config)}
<script>
const vscode = acquireVsCodeApi();
window.addEventListener('message', function(event) { qtHandleMessage(event.data); });
${getQuestTodoScript(config)}
</script>
</body>
</html>`;
}

export class QuestTodoEmbeddedViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext,
        private readonly config?: QuestTodoViewConfig,
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ],
        };
        webviewView.webview.html = _getEmbeddedQuestTodoHtml(webviewView.webview, this.extensionUri, this.config);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            await handleQuestTodoMessage(message, webviewView.webview);
        }, undefined, this.context.subscriptions);

        const cfgMode = this.config?.mode;
        const watcher = setupQuestTodoWatcher(() => {
            if (cfgMode === 'workspace-file' || cfgMode === 'session') {
                // For workspace-file and session modes, re-invoke the correct handler
                handleQuestTodoMessage(
                    { type: 'qtGetTodos', questId: cfgMode === 'session' ? '__session__' : '__all_workspace__', file: 'all' },
                    webviewView.webview,
                );
            } else {
                sendQuestTodoRefresh(webviewView.webview);
            }
        });
        if (watcher) {
            this.context.subscriptions.push(watcher);
        }

        webviewView.onDidDispose(() => {
            this._view = undefined;
        });
    }

    /**
     * Select a todo by ID in this embedded view.
     * Sends the pending-select message to the webview and triggers a refresh.
     */
    selectTodo(todoId: string, file?: string): void {
        if (!this._view) return;
        this._view.webview.postMessage({
            type: 'qtPendingSelect',
            state: { todoId, file: file || '' },
        });
        // Also trigger a refresh so the todo list re-renders and picks up the selection
        sendQuestTodoRefresh(this._view.webview);
    }

    /** Whether the embedded view is currently resolved and available. */
    get isViewAvailable(): boolean {
        return !!this._view;
    }

    /** Trigger a full refresh of the todo list in this panel. */
    refresh(): void {
        if (!this._view) return;
        // Re-invoke the message handler with a synthetic qtGetTodos request
        handleQuestTodoMessage(
            { type: 'qtGetTodos', questId: '__session__', file: 'all' },
            this._view.webview
        );
    }
}

// ============================================================================
// Legacy standalone registration (kept for backward compatibility but
// no longer registered in package.json or extension.ts)
// ============================================================================

export function registerQuestTodoPanel(_context: vscode.ExtensionContext): void {
    // No-op — Quest TODO is now embedded in the T3 panel accordion.
    // Kept to avoid breaking imports until all references are cleaned up.
}
