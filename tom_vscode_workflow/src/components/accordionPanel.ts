/**
 * Reusable Accordion Panel Component
 *
 * Adapted from tom_vscode_extension for the TOM Tracker extension.
 * 
 * A configurable multi-section panel with:
 * - Accordion behavior: opening one section collapses unpinned others
 * - Pin functionality: pinned sections stay open
 * - Resizable sections via drag handles
 * - Vertical tab rotation for collapsed sections
 *
 * NOTE: This is a copy from tom_vscode_extension/src/handlers/accordionPanel.ts.
 * A shared package should be extracted if both extensions diverge significantly.
 *
 * Usage:
 *   const sections: AccordionSection[] = [
 *       { id: 'file1', title: 'FILE1', icon: 'file', content: '<textarea>...</textarea>' },
 *   ];
 *   const html = getAccordionHtml({ codiconsUri, sections });
 */

import * as vscode from 'vscode';

// ============================================================================
// Types
// ============================================================================

/** Section configuration for accordion panel */
export interface AccordionSection {
    /** Unique identifier for the section */
    id: string;
    /** Display title (shown in header) */
    title: string;
    /** Codicon name (e.g., 'book', 'note', 'robot') */
    icon: string;
    /** HTML content for the section body */
    content: string;
}

/** Configuration for the accordion panel */
export interface AccordionPanelConfig {
    /** Codicons CSS URI for webview */
    codiconsUri: string;
    /** Array of section configurations */
    sections: AccordionSection[];
    /** ID of initially expanded section (defaults to first section) */
    initialExpanded?: string;
    /** Custom CSS to append to base styles */
    additionalCss?: string;
    /** Custom JavaScript to append to base script */
    additionalScript?: string;
}

// ============================================================================
// CSS
// ============================================================================

/**
 * Get the base CSS styles for accordion panel.
 */
export function getAccordionStyles(): string {
    return `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-panel-background); height: 100vh; display: flex; flex-direction: row; overflow: hidden; }
.accordion-container { display: flex; flex-direction: row; width: 100%; height: 100%; overflow: hidden; }
.accordion-section { display: flex; flex-direction: column; border-right: 1px solid var(--vscode-panel-border); overflow: hidden; }
.accordion-section:last-child { border-right: none; }
.accordion-section.collapsed { flex: 0 0 18px; width: 18px; }
.accordion-section.collapsed .section-content { display: none; }
.accordion-section.collapsed .header-expanded { display: none; }
.accordion-section.collapsed .header-collapsed { display: flex; }
.accordion-section.expanded { flex: 1 1 auto; min-width: 120px; }
.accordion-section.expanded .section-content { display: flex; }
.accordion-section.expanded .header-expanded { display: flex; }
.accordion-section.expanded .header-collapsed { display: none; }
.resize-handle { flex: 0 0 4px; width: 4px; background: transparent; cursor: col-resize; transition: background 0.1s; }
.resize-handle:hover, .resize-handle.dragging { background: var(--vscode-focusBorder); }
.header-expanded { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 18px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; white-space: nowrap; }
.header-expanded:hover { background: var(--vscode-list-hoverBackground); }
.header-expanded .arrow { display: flex; align-items: center; }
.header-expanded .arrow .codicon { font-size: 12px; }
.header-expanded .icon { display: flex; align-items: center; opacity: 0.8; }
.header-expanded .icon .codicon { font-size: 14px; }
.header-expanded .title { font-size: 11px; font-weight: normal; text-transform: uppercase; }
.header-expanded .pin-btn { margin-left: auto; opacity: 0.3; cursor: pointer; background: none; border: none; color: var(--vscode-foreground); padding: 0 2px; display: flex; align-items: center; }
.header-expanded .pin-btn .codicon { font-size: 12px; }
.header-expanded .pin-btn:hover { opacity: 0.7; }
.header-expanded .pin-btn.pinned { opacity: 1; }
.header-collapsed { writing-mode: vertical-lr; display: none; align-items: center; justify-content: flex-start; padding: 4px 0; background: var(--vscode-sideBarSectionHeader-background); cursor: pointer; white-space: nowrap; height: 100%; width: 18px; }
.header-collapsed:hover { background: var(--vscode-list-hoverBackground); }
.header-collapsed .arrow { display: flex; align-items: center; margin-bottom: 2px; }
.header-collapsed .arrow .codicon { font-size: 12px; }
.header-collapsed .icon { display: flex; align-items: center; margin-bottom: 4px; opacity: 0.8; }
.header-collapsed .icon .codicon { font-size: 14px; }
.header-collapsed .title { font-size: 11px; font-weight: normal; text-transform: uppercase; }
.section-content { flex: 1; display: flex; flex-direction: column; padding: 8px; gap: 6px; overflow: hidden; }
.toolbar { display: flex; flex-direction: row; flex-wrap: wrap; gap: 0px; align-items: center; }
.toolbar label { font-size: 12px; padding-right: 4px; }
.toolbar select { padding: 0 4px; height: 22px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 3px; font-size: 12px; min-width: 60px; max-width: 120px; }
.toolbar button { padding: 3px 4px; height: 22px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
.toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.toolbar button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.toolbar button.primary:hover { background: var(--vscode-button-hoverBackground); }
.icon-btn { padding: 3px 6px; height: 22px; font-size: 12px; opacity: 0.8; display: inline-flex; align-items: center; justify-content: center; background: none; border: none; color: var(--vscode-foreground); cursor: pointer; }
.icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.icon-btn.danger { color: var(--vscode-errorForeground); }
.icon-btn .codicon { font-size: 14px; }
.codicon { font-family: codicon; font-size: 12px; line-height: 1; }
textarea { flex: 1; min-height: 50px; resize: none; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 13px; }
textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
.status-bar { font-size: 11px; color: var(--vscode-descriptionForeground); }
.sample-content { padding: 12px; color: var(--vscode-descriptionForeground); }
.sample-content h3 { font-size: 13px; margin-bottom: 8px; color: var(--vscode-foreground); }
.sample-content p { font-size: 12px; line-height: 1.5; }
`;
}

// ============================================================================
// JavaScript
// ============================================================================

/**
 * Get the base JavaScript for accordion panel behavior.
 */
export function getAccordionScript(sections: AccordionSection[], initialExpanded?: string): string {
    const firstSection = sections[0]?.id || '';
    const defaultExpanded = initialExpanded || firstSection;

    const sectionsJson = JSON.stringify(sections.map(s => ({
        id: s.id,
        icon: `<span class="codicon codicon-${s.icon}"></span>`,
        title: s.title,
    })));

    const contentsJson = JSON.stringify(
        sections.reduce((acc, s) => {
            acc[s.id] = s.content;
            return acc;
        }, {} as Record<string, string>),
    );

    return `
var vscode = acquireVsCodeApi();
var sectionsConfig = ${sectionsJson};
var sectionContents = ${contentsJson};
var state = { expanded: ['${defaultExpanded}'], pinned: [] };
var _rendered = false;

function loadState() {
    try {
        var s = vscode.getState();
        if (s && s.expanded && Array.isArray(s.expanded)) state.expanded = s.expanded;
        if (s && s.pinned && Array.isArray(s.pinned)) state.pinned = s.pinned;
    } catch(e) {}
}

function saveState() { vscode.setState(state); }
function isExpanded(id) { return state.expanded && state.expanded.includes(id); }
function isPinned(id) { return state.pinned && state.pinned.includes(id); }

function toggleSection(id) {
    if (isExpanded(id)) {
        if (isPinned(id)) return;
        var idx = state.expanded.indexOf(id);
        if (idx >= 0) state.expanded.splice(idx, 1);
        if (state.expanded.length === 0) {
            var next = sectionsConfig.find(function(s) { return s.id !== id; });
            if (next) state.expanded.push(next.id);
        }
    } else {
        state.expanded = state.expanded.filter(function(eid) { return isPinned(eid); });
        state.expanded.push(id);
    }
    saveState();
    render();
}

function togglePin(id, e) {
    e.stopPropagation();
    var idx = state.pinned.indexOf(id);
    if (idx >= 0) { state.pinned.splice(idx, 1); }
    else { state.pinned.push(id); if (!isExpanded(id)) state.expanded.push(id); }
    saveState();
    render();
}

function getSectionContent(id) {
    return sectionContents[id] || '<div class="sample-content">Unknown section</div>';
}

function render() {
    var container = document.getElementById('container');
    if (!_rendered) {
        var html = '';
        sectionsConfig.forEach(function(sec) {
            var exp = isExpanded(sec.id);
            var pin = isPinned(sec.id);
            html += '<div class="accordion-section ' + (exp ? 'expanded' : 'collapsed') + '" data-section="' + sec.id + '">';
            html += '<div class="header-expanded" data-toggle="' + sec.id + '"><span class="arrow"><span class="codicon codicon-chevron-right"></span></span><span class="icon">' + sec.icon + '</span><span class="title">' + sec.title + '</span><button class="pin-btn ' + (pin ? 'pinned' : '') + '" data-pin="' + sec.id + '" title="' + (pin ? 'Unpin' : 'Pin') + '"><span class="codicon ' + (pin ? 'codicon-pinned' : 'codicon-pin') + '"></span></button></div>';
            html += '<div class="header-collapsed" data-toggle="' + sec.id + '"><span class="arrow"><span class="codicon codicon-chevron-down"></span></span><span class="icon">' + sec.icon + '</span><span class="title">' + sec.title + '</span></div>';
            html += '<div class="section-content">' + getSectionContent(sec.id) + '</div></div>';
        });
        container.innerHTML = html;
        _rendered = true;
        attachEventListeners();
        updateResizeHandles();
        if (typeof onRenderComplete === 'function') onRenderComplete();
    } else {
        sectionsConfig.forEach(function(sec) {
            var el = container.querySelector('[data-section="' + sec.id + '"]');
            if (!el) return;
            var exp = isExpanded(sec.id);
            var pin = isPinned(sec.id);
            if (exp) { el.classList.remove('collapsed'); el.classList.add('expanded'); el.style.flex = ''; }
            else { el.classList.remove('expanded'); el.classList.add('collapsed'); el.style.flex = ''; }
            var pinBtn = el.querySelector('[data-pin="' + sec.id + '"]');
            if (pinBtn) {
                if (pin) { pinBtn.classList.add('pinned'); pinBtn.title = 'Unpin'; }
                else { pinBtn.classList.remove('pinned'); pinBtn.title = 'Pin'; }
                var pinIcon = pinBtn.querySelector('.codicon');
                if (pinIcon) {
                    pinIcon.classList.remove('codicon-pin', 'codicon-pinned');
                    pinIcon.classList.add(pin ? 'codicon-pinned' : 'codicon-pin');
                }
            }
        });
        updateResizeHandles();
        if (typeof onRenderComplete === 'function') onRenderComplete();
    }
}

function updateResizeHandles() {
    var container = document.getElementById('container');
    container.querySelectorAll('.resize-handle').forEach(function(h) { h.remove(); });
    var expandedIds = [];
    sectionsConfig.forEach(function(sec) { if (isExpanded(sec.id)) expandedIds.push(sec.id); });
    for (var i = 1; i < expandedIds.length; i++) {
        var rightEl = container.querySelector('[data-section="' + expandedIds[i] + '"]');
        if (rightEl) {
            var handle = document.createElement('div');
            handle.className = 'resize-handle';
            handle.dataset.resizeLeft = expandedIds[i - 1];
            handle.dataset.resizeRight = expandedIds[i];
            container.insertBefore(handle, rightEl);
            handle.addEventListener('mousedown', function(e) { startResize(e, this); });
        }
    }
}

function attachEventListeners() {
    document.querySelectorAll('[data-toggle]').forEach(function(el) { el.addEventListener('click', function() { toggleSection(el.dataset.toggle); }); });
    document.querySelectorAll('[data-pin]').forEach(function(el) { el.addEventListener('click', function(e) { togglePin(el.dataset.pin, e); }); });
    document.querySelectorAll('[data-action]').forEach(function(el) { el.addEventListener('click', function() { handleAction(el.dataset.action, el.dataset.id); }); });
}

var resizing = null;
var DRAG_THRESHOLD = 5;
function startResize(e, handle) {
    e.preventDefault();
    var leftId = handle.dataset.resizeLeft;
    var rightId = handle.dataset.resizeRight;
    var leftEl = document.querySelector('[data-section="' + leftId + '"]');
    var rightEl = document.querySelector('[data-section="' + rightId + '"]');
    if (!leftEl || !rightEl) return;
    var startX = e.clientX;
    var leftWidth = leftEl.offsetWidth;
    var rightWidth = rightEl.offsetWidth;
    var dragStarted = false;
    function onMove(ev) {
        var dx = ev.clientX - startX;
        if (!dragStarted) { if (Math.abs(dx) < DRAG_THRESHOLD) return; dragStarted = true; handle.classList.add('dragging'); }
        leftEl.style.flex = '0 0 ' + Math.max(120, leftWidth + dx) + 'px';
        rightEl.style.flex = '0 0 ' + Math.max(120, rightWidth - dx) + 'px';
    }
    function onUp() { if (dragStarted) handle.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

function handleAction(action, id) {
    vscode.postMessage({ type: 'action', action: action, sectionId: id });
}

loadState();
render();
`;
}

// ============================================================================
// HTML Generation
// ============================================================================

/**
 * Generate complete HTML for an accordion panel.
 */
export function getAccordionHtml(config: AccordionPanelConfig): string {
    const css = getAccordionStyles() + (config.additionalCss || '');
    const script = getAccordionScript(config.sections, config.initialExpanded) + (config.additionalScript || '');

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<link href="${config.codiconsUri}" rel="stylesheet" />
<style>${css}</style></head>
<body>
<div class="accordion-container" id="container">Loading...</div>
<script>${script}</script>
</body></html>`;
}

// ============================================================================
// Provider Helper
// ============================================================================

/**
 * Helper to create a simple accordion panel provider.
 */
export function createAccordionPanelProvider(
    context: vscode.ExtensionContext,
    sections: AccordionSection[],
    messageHandler?: (message: any, webview: vscode.Webview) => void,
): vscode.WebviewViewProvider {
    return {
        resolveWebviewView(
            webviewView: vscode.WebviewView,
            _resolveContext: vscode.WebviewViewResolveContext,
            _token: vscode.CancellationToken,
        ): void {
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                ],
            };

            const codiconsUri = webviewView.webview.asWebviewUri(
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
            );

            webviewView.webview.html = getAccordionHtml({
                codiconsUri: codiconsUri.toString(),
                sections,
            });

            if (messageHandler) {
                webviewView.webview.onDidReceiveMessage(
                    (message) => messageHandler(message, webviewView.webview),
                    undefined,
                    context.subscriptions,
                );
            }
        },
    };
}
