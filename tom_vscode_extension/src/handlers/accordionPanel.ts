/**
 * Reusable Accordion Panel Component
 * 
 * A configurable multi-section panel with:
 * - Accordion behavior: opening one section collapses unpinned others
 * - Pin functionality: pinned sections stay open
 * - Resizable sections
 * - Vertical tab rotation for collapsed sections
 * 
 * Usage:
 * 1. Define sections with id, title, icon (codicon name), and content HTML
 * 2. Call getAccordionHtml() with codiconsUri and sections config
 * 3. Handle messages in your provider
 */

import * as vscode from 'vscode';
import { readMediaText } from '../utils/webviewLoader.js';

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

/**
 * Get the base CSS styles for accordion panel.
 * Source of truth: `media/shared/accordion.css` (read verbatim).
 */
export function getAccordionStyles(): string {
    return readMediaText('shared', 'accordion.css');
}

/**
 * Get the base JavaScript for accordion panel behavior
 */
export function getAccordionScript(sections: AccordionSection[], initialExpanded?: string): string {
    const firstSection = sections[0]?.id || '';
    const defaultExpanded = initialExpanded || firstSection;
    
    // Section HTML is embedded as JSON *inside* the inline <script> below, so any
    // literal `</script>` (or `<!--`) in a section's content would prematurely
    // close the script element and dump the rest of the page as text. Escape every
    // `<` to a unicode escape (backslash-u-003c): harmless inside a JS string
    // literal (the engine decodes it back to `<`) but invisible to the HTML
    // parser. Same technique as webviewLoader's serializeInit.
    const escapeForScript = (json: string): string => json.replace(/</g, '\\u003c');

    const sectionsJson = escapeForScript(JSON.stringify(sections.map(s => ({
        id: s.id,
        icon: `<span class="codicon codicon-${s.icon}"></span>`,
        title: s.title
    }))));

    const contentsJson = escapeForScript(JSON.stringify(
        sections.reduce((acc, s) => {
            acc[s.id] = s.content;
            return acc;
        }, {} as Record<string, string>)
    ));

    // Generated data-prefix declares the globals the static body reads; the
    // body (functions + loadState()/render() bootstrap) lives in
    // media/accordionPanel/main.js and is inlined verbatim. They must compose
    // into one <script> (single acquireVsCodeApi(); onRenderComplete hoisting
    // across base + the consumer's additionalScript).
    const prefix = `
var vscode = acquireVsCodeApi();
var sectionsConfig = ${sectionsJson};
var sectionContents = ${contentsJson};
var state = { expanded: ['${defaultExpanded}'], pinned: [] };
var _rendered = false;
`;
    return prefix + readMediaText('accordionPanel', 'main.js');
}

/**
 * Generate complete HTML for an accordion panel
 */
export function getAccordionHtml(config: AccordionPanelConfig): string {
    const css = getAccordionStyles() + (config.additionalCss || '');
    const script = getAccordionScript(config.sections, config.initialExpanded) + (config.additionalScript || '');

    const tokens: Record<string, string> = {
        '{{codiconsUri}}': config.codiconsUri,
        '{{css}}': css,
        '{{script}}': script,
    };
    let html = readMediaText('accordionPanel', 'index.html');
    for (const [token, value] of Object.entries(tokens)) {
        html = html.split(token).join(value);
    }
    return html;
}

/**
 * Helper to create a simple accordion panel provider
 */
export function createAccordionPanelProvider(
    context: vscode.ExtensionContext,
    sections: AccordionSection[],
    messageHandler?: (message: any, webview: vscode.Webview) => void
): vscode.WebviewViewProvider {
    return {
        resolveWebviewView(
            webviewView: vscode.WebviewView,
            _resolveContext: vscode.WebviewViewResolveContext,
            _token: vscode.CancellationToken
        ): void {
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
                ]
            };

            const codiconsUri = webviewView.webview.asWebviewUri(
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
            );

            webviewView.webview.html = getAccordionHtml({
                codiconsUri: codiconsUri.toString(),
                sections
            });

            if (messageHandler) {
                webviewView.webview.onDidReceiveMessage(
                    (message) => messageHandler(message, webviewView.webview),
                    undefined,
                    context.subscriptions
                );
            }
        }
    };
}
