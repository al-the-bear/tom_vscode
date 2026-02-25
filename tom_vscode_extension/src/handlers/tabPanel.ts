/**
 * Reusable Tab Panel Component
 *
 * A configurable multi-tab panel with:
 * - Horizontal tab bar with icons and labels
 * - Active tab highlighting with bottom border
 * - Tab state persistence via vscode.getState/setState
 * - Support for custom CSS and JS injection per tab
 *
 * Usage:
 * 1. Define tabs with id, title, icon (codicon name), and content HTML
 * 2. Call getTabPanelHtml() with codiconsUri and tabs config
 * 3. Handle messages in your provider
 */

import * as vscode from 'vscode';

/** Tab configuration for tab panel */
export interface TabSection {
    /** Unique identifier for the tab */
    id: string;
    /** Display title (shown in tab bar) */
    title: string;
    /** Codicon name (e.g., 'book', 'note', 'robot') */
    icon: string;
    /** HTML content for the tab body */
    content: string;
}

/** Configuration for the tab panel */
export interface TabPanelConfig {
    /** Codicons CSS URI for webview */
    codiconsUri: string;
    /** Array of tab configurations */
    tabs: TabSection[];
    /** ID of initially active tab (defaults to first tab) */
    initialActive?: string;
    /** Custom CSS to append to base styles */
    additionalCss?: string;
    /** Custom JavaScript to append to base script */
    additionalScript?: string;
}

/**
 * Get the base CSS styles for tab panel
 */
export function getTabPanelStyles(): string {
    return `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-panel-background); height: 100vh; overflow: hidden; }
.tab-container { display: flex; flex-direction: column; height: 100%; width: 100%; }
.tab-bar {
    display: flex; flex-shrink: 0; align-items: stretch;
    background: var(--vscode-sideBarSectionHeader-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    height: 28px; gap: 0; overflow-x: auto;
    scrollbar-width: none;
}
.tab-bar::-webkit-scrollbar { display: none; }
.tab-btn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 0 10px; font-size: 11px; text-transform: uppercase;
    background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--vscode-foreground); cursor: pointer; opacity: 0.6;
    white-space: nowrap; flex-shrink: 0;
}
.tab-btn:hover { opacity: 0.8; }
.tab-btn.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
.tab-btn .codicon { font-size: 14px; }
.tab-content-area { flex: 1; overflow: hidden; position: relative; }
.tab-content { display: none; height: 100%; width: 100%; }
.tab-content.active { display: flex; flex-direction: column; }
.toolbar { display: flex; flex-direction: row; flex-wrap: wrap; gap: 0px; align-items: center; }
.toolbar label { font-size: 12px; padding-right: 4px; }
.toolbar select { padding: 0 4px; height: 22px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 3px; font-size: 12px; min-width: 60px; max-width: 120px; }
.toolbar button { padding: 3px 4px; height: 22px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
.toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.toolbar button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.toolbar button.primary:hover { background: var(--vscode-button-hoverBackground); }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: none; border: none; color: var(--vscode-foreground); cursor: pointer; border-radius: 3px; opacity: 0.8; }
.icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.icon-btn.danger:hover { color: var(--vscode-errorForeground); }
.icon-btn .codicon { font-size: 14px; }
textarea { flex: 1; min-height: 50px; resize: none; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 13px; }
textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
.status-bar { font-size: 11px; color: var(--vscode-descriptionForeground); }
.simple-content { display: flex; flex-direction: column; height: 100%; padding: 8px; gap: 6px; }
`;
}

/**
 * Get the base JavaScript for tab panel behavior
 */
export function getTabPanelScript(tabs: TabSection[], initialActive?: string): string {
    const firstTab = tabs[0]?.id || '';
    const defaultActive = initialActive || firstTab;

    return `
var vscode = acquireVsCodeApi();

(function() {
    var tabBtns = document.querySelectorAll('.tab-btn');

    function switchTab(tabId) {
        tabBtns.forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        var btn = document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
        var content = document.querySelector('[data-tab-content="' + tabId + '"]');
        if (btn && content) { btn.classList.add('active'); content.classList.add('active'); }
        var state = vscode.getState() || {};
        state.activeTab = tabId;
        vscode.setState(state);
    }

    tabBtns.forEach(function(btn) {
        btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
    });

    // Restore persisted tab or use default
    var s = vscode.getState();
    if (s && s.activeTab) { switchTab(s.activeTab); }
    else { switchTab('${defaultActive}'); }

    // Action button handler
    document.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-action]');
        if (btn) { vscode.postMessage({ type: 'action', action: btn.dataset.action, sectionId: btn.dataset.id }); }
    });
})();
`;
}

/**
 * Generate complete HTML for a tab panel
 */
export function getTabPanelHtml(config: TabPanelConfig): string {
    const css = getTabPanelStyles() + (config.additionalCss || '');
    const firstTab = config.tabs[0]?.id || '';
    const defaultActive = config.initialActive || firstTab;

    let tabBarHtml = '';
    let tabContentHtml = '';
    for (const tab of config.tabs) {
        const isActive = tab.id === defaultActive;
        tabBarHtml += `<button class="tab-btn${isActive ? ' active' : ''}" data-tab="${tab.id}"><span class="codicon codicon-${tab.icon}"></span> ${tab.title}</button>`;
        tabContentHtml += `<div class="tab-content${isActive ? ' active' : ''}" data-tab-content="${tab.id}">${tab.content}</div>`;
    }

    const script = getTabPanelScript(config.tabs, config.initialActive) + (config.additionalScript || '');

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<link href="${config.codiconsUri}" rel="stylesheet" />
<style>${css}</style></head>
<body>
<div class="tab-container">
  <div class="tab-bar">${tabBarHtml}</div>
  <div class="tab-content-area">${tabContentHtml}</div>
</div>
<script>${script}</script>
</body></html>`;
}

/**
 * Helper to create a simple tab panel provider
 */
export function createTabPanelProvider(
    context: vscode.ExtensionContext,
    tabs: TabSection[],
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

            webviewView.webview.html = getTabPanelHtml({
                codiconsUri: codiconsUri.toString(),
                tabs,
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
