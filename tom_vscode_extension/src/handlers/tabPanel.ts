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
import { readMediaText, stripHtmlComments } from '../utils/webviewLoader.js';

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
 * Get the base CSS styles for tab panel.
 * Source of truth: `media/tabPanel/style.css` (read verbatim).
 */
export function getTabPanelStyles(): string {
    return readMediaText('tabPanel', 'style.css');
}

/**
 * Get the base JavaScript for tab panel behavior
 */
export function getTabPanelScript(tabs: TabSection[], initialActive?: string): string {
    const firstTab = tabs[0]?.id || '';
    const defaultActive = initialActive || firstTab;

    // Generated data-prefix declares the globals the static body reads; the
    // body (the tab-switching IIFE) lives in media/tabPanel/main.js and is
    // inlined verbatim. They compose into one <script> (single
    // acquireVsCodeApi(); the consumer's additionalScript is appended after).
    const prefix = `
var vscode = acquireVsCodeApi();
var __defaultActive = '${defaultActive}';
`;
    return prefix + readMediaText('tabPanel', 'main.js');
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

    const tokens: Record<string, string> = {
        '{{codiconsUri}}': config.codiconsUri,
        '{{css}}': css,
        '{{tabBar}}': tabBarHtml,
        '{{tabContent}}': tabContentHtml,
        '{{script}}': script,
    };
    // Strip the shell's dev-doc comment before substitution: it references the
    // {{css}}/{{script}} tokens verbatim and would otherwise absorb the whole
    // css+script blob (see stripHtmlComments).
    let html = stripHtmlComments(readMediaText('tabPanel', 'index.html'));
    for (const [token, value] of Object.entries(tokens)) {
        html = html.split(token).join(value);
    }
    return html;
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
