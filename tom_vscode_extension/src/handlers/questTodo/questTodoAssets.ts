/**
 * Static webview assets for the Quest TODO panel.
 *
 * Wave 3.2 continuation — `questTodoPanel-handler.ts` is ~4,000
 * lines; the bulk is the webview script embedded as a template
 * literal. Extracting the CSS + HTML fragment (the two shortest,
 * fully-static pieces) out to this module lets the handler be a
 * bit less of a monolith without touching the complex script
 * builder that owns the panel's runtime state machine.
 *
 * The script builder (`getQuestTodoScript`) stays in the handler
 * for now — its 1,800+ line template literal couples to the
 * handler's webview state contract and wants a handler-specific
 * design pass before being moved.
 */

import type { QuestTodoViewConfig } from '../questTodoPanel-handler';

/** CSS for the Quest TODO section (top bar, split panes, pickers, mass-add overlay). */
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

/** HTML fragment for the Quest TODO section content (inside accordion). */
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
    <button class="icon-btn" id="qt-btn-delete-all" title="Delete all session todos" style="display:none"><span class="codicon codicon-trash"></span></button>
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
