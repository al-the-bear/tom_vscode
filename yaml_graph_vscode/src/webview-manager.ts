/**
 * WebviewManager — manages the webview panel's HTML content and
 * message passing between extension host and webview.
 *
 * Generates the HTML structure containing the tree panel, Mermaid preview,
 * node editor, and status bar. Handles all postMessage communication.
 */

import * as vscode from 'vscode';
import type { GraphType } from 'yaml-graph-core';
import type { ValidationError } from 'yaml-graph-core';
import type {
    ExtensionMessage, WebviewMessage, TreeNode, WebviewManagerOptions
} from './types.js';

export class WebviewManager {
    private readonly panel: vscode.WebviewPanel;
    private readonly graphType: GraphType;
    private readonly options: WebviewManagerOptions;
    private messageHandler?: (msg: WebviewMessage) => void;
    private readyResolve?: () => void;
    private readyPromise: Promise<void>;

    constructor(
        panel: vscode.WebviewPanel,
        graphType: GraphType,
        options?: Partial<WebviewManagerOptions>
    ) {
        this.panel = panel;
        this.graphType = graphType;
        this.options = {
            extensionUri: options?.extensionUri ?? { fsPath: '' },
            baseCss: options?.baseCss,
            graphTypeCss: options?.graphTypeCss ?? graphType.styleSheet,
        };

        // Create ready promise — resolved when webview sends 'ready'
        this.readyPromise = new Promise<void>((resolve) => {
            this.readyResolve = resolve;
        });

        // Enable scripts in the webview (required for message passing)
        this.panel.webview.options = { enableScripts: true };

        // Set initial HTML
        this.panel.webview.html = this.generateHtml();

        // Listen for messages from webview
        this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            if (msg.type === 'ready') {
                this.readyResolve?.();
                return;
            }
            if (this.messageHandler) {
                this.messageHandler(msg);
            }
        });
    }

    /**
     * Wait until the webview script has loaded and sent the 'ready' signal.
     * Call this before sending the initial updateAll message.
     * Times out after 5 seconds to prevent hanging forever.
     */
    waitForReady(): Promise<void> {
        return Promise.race([
            this.readyPromise,
            new Promise<void>(resolve => setTimeout(resolve, 5000)),
        ]);
    }

    /**
     * Register a handler for messages from the webview.
     */
    onMessage(handler: (msg: WebviewMessage) => void): void {
        this.messageHandler = handler;
    }

    /**
     * Send a message to the webview.
     */
    postMessage(message: ExtensionMessage): void {
        this.panel.webview.postMessage(message);
    }

    /**
     * Update the webview with new conversion results.
     * Sends an updateAll message containing YAML, Mermaid, tree data, and errors.
     */
    update(
        yamlText: string,
        mermaidSource: string,
        treeData: TreeNode[],
        errors: ValidationError[]
    ): void {
        this.postMessage({
            type: 'updateAll',
            yamlText,
            mermaidSource,
            treeData,
            errors,
        });
    }

    /**
     * Select a node in the tree panel.
     */
    selectTreeNode(nodeId: string): void {
        this.postMessage({ type: 'selectNode', nodeId });
    }

    /**
     * Highlight a node in the Mermaid preview.
     */
    highlightMermaidNode(nodeId: string): void {
        this.postMessage({ type: 'highlightMermaidNode', nodeId });
    }

    /**
     * Generate the initial HTML for the webview.
     * Contains the split-pane layout with tree, preview, node editor, and status bar.
     */
    generateHtml(): string {
        const nonce = this.generateNonce();
        const graphTypeCss = this.options.graphTypeCss ?? '';
        const baseCss = this.options.baseCss ?? '';
        const title = `${this.graphType.id} Editor`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src 'unsafe-inline';
                   script-src 'nonce-${nonce}' https://cdn.jsdelivr.net 'unsafe-eval';
                   img-src data: https:;
                   font-src https:;">
    <title>${this.escapeHtml(title)}</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
    <style>
        /* Base theme — adapts to VS Code theme via CSS variables */
        :root {
            --tree-width: 280px;
            --node-editor-height: 200px;
            --border-color: var(--vscode-panel-border, #333);
            --bg-color: var(--vscode-editor-background, #1e1e1e);
            --fg-color: var(--vscode-editor-foreground, #d4d4d4);
            --select-bg: var(--vscode-list-activeSelectionBackground, #094771);
        }

        body {
            margin: 0;
            padding: 0;
            background: var(--bg-color);
            color: var(--fg-color);
            font-family: var(--vscode-font-family, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            height: 100vh;
            overflow: hidden;
        }

        #layout {
            display: flex;
            height: 100vh;
        }

        #left-panel {
            width: var(--tree-width);
            min-width: 150px;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        #resize-handle {
            width: 5px;
            cursor: col-resize;
            background: var(--border-color);
            flex-shrink: 0;
            transition: background 0.15s;
        }
        #resize-handle:hover,
        #resize-handle.dragging {
            background: var(--vscode-focusBorder, #007fd4);
        }

        /* Collapsible sections */
        .collapsible-section {
            border-bottom: 1px solid var(--border-color);
        }
        .section-header {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px;
            cursor: pointer;
            user-select: none;
            background: var(--vscode-sideBar-background, #252526);
        }
        .section-header:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .section-toggle {
            font-size: 10px;
            transition: transform 0.2s;
        }
        .section-toggle.collapsed {
            transform: rotate(-90deg);
        }
        .section-title {
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .section-content {
            padding: 8px;
            display: block;
        }
        .section-content.collapsed {
            display: none;
        }

        /* Document Settings form fields */
        #doc-settings .form-field {
            margin-bottom: 8px;
        }
        #doc-settings label {
            display: block;
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #8b8b8b);
            margin-bottom: 3px;
        }
        #doc-settings .form-input {
            width: 100%;
            box-sizing: border-box;
            background: var(--vscode-input-background, #3c3c3c);
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            color: var(--fg-color);
            padding: 4px 6px;
            font-size: 12px;
            border-radius: 2px;
        }
        #doc-settings .form-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder, #007fd4);
        }
        #doc-settings .form-input.readonly {
            background: var(--vscode-input-background, #3c3c3c);
            opacity: 0.7;
            cursor: not-allowed;
        }
        #doc-settings textarea.form-input {
            resize: vertical;
            min-height: 40px;
        }
        #doc-settings select.form-input {
            cursor: pointer;
        }

        #tree-container {
            flex: 1;
            overflow: auto;
            padding: 8px;
        }

        #node-editor {
            height: var(--node-editor-height);
            min-height: 100px;
            border-top: 1px solid var(--border-color);
            overflow: auto;
            padding: 8px;
        }

        #preview-container {
            flex: 1;
            overflow: auto;
            position: relative;
            cursor: grab;
        }
        #preview-container.panning {
            cursor: grabbing;
            user-select: none;
        }

        #zoom-controls {
            position: sticky;
            top: 0;
            right: 0;
            float: right;
            display: flex;
            gap: 4px;
            padding: 4px 6px;
            background: transparent;
            border-radius: 0 0 0 6px;
            z-index: 10;
            align-items: center;
        }

        .zoom-btn {
            width: 28px;
            height: 28px;
            border: 1px solid var(--border-color);
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--fg-color);
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            line-height: 28px;
            text-align: center;
            padding: 0;
        }
        .zoom-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
        }

        #zoom-level {
            font-size: 11px;
            line-height: 28px;
            min-width: 40px;
            text-align: center;
            color: var(--fg-color);
            cursor: pointer;
            border-radius: 3px;
            padding: 0 4px;
        }
        #zoom-level:hover {
            background: var(--vscode-button-secondaryBackground, #3a3d41);
        }

        #zoom-input {
            width: 48px;
            height: 24px;
            font-size: 11px;
            text-align: center;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--fg-color);
            border: 1px solid var(--vscode-focusBorder, #007fd4);
            border-radius: 3px;
            outline: none;
            padding: 0 2px;
        }

        #mermaid-sizer {
            display: inline-block;
            min-width: max-content;
            min-height: max-content;
            padding: 16px;
        }

        #mermaid-wrapper {
            transform-origin: top left;
            transition: transform 0.15s ease;
            display: inline-block;
        }

        #mermaid-output {
            display: inline-block;
        }

        /* Make SVG nodes clickable */
        #mermaid-output .node,
        #mermaid-output .state,
        #mermaid-output .entityBox,
        #mermaid-output .stateGroup,
        #mermaid-output .edgePath,
        #mermaid-output .edgeLabel {
            cursor: pointer;
        }

        #status-bar {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            height: 22px;
            background: var(--vscode-statusBar-background, #007acc);
            color: var(--vscode-statusBar-foreground, #fff);
            font-size: 12px;
            line-height: 22px;
            padding: 0 8px;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        /* Tree styling */
        .tree-row {
            padding: 2px 4px;
            cursor: pointer;
            border-radius: 3px;
            white-space: nowrap;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .tree-row:hover {
            background: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        .tree-row.selected {
            background: var(--select-bg);
        }
        .tree-toggle {
            width: 16px;
            text-align: center;
            font-size: 10px;
            flex-shrink: 0;
            user-select: none;
        }
        .tree-indent {
            width: 16px;
            flex-shrink: 0;
        }
        .tree-children {
            list-style: none;
            padding-left: 16px;
            margin: 0;
        }
        .tree-children.collapsed {
            display: none;
        }

        /* Sidebar Toolbar */
        #sidebar-toolbar {
            display: flex;
            gap: 4px;
            padding: 6px 8px;
            border-bottom: 1px solid var(--border-color);
            background: var(--bg-color);
        }
        .toolbar-btn {
            height: 24px;
            padding: 0 8px;
            border: 1px solid var(--border-color);
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--fg-color);
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .toolbar-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
        }
        .toolbar-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .toolbar-btn.primary {
            background: var(--vscode-button-background, #0e639c);
            border-color: var(--vscode-button-background, #0e639c);
        }
        .toolbar-btn.primary:hover {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }
        .toolbar-spacer {
            flex: 1;
        }

        /* Popup Overlay */
        #popup-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 22px; /* Above status bar */
            background: rgba(0, 0, 0, 0.4);
            z-index: 100;
        }
        #popup-overlay.visible {
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #popup-container {
            background: var(--bg-color);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            min-width: 400px;
            min-height: 300px;
            max-width: 90vw;
            max-height: 90vh;
            display: flex;
            flex-direction: column;
            resize: both;
            overflow: hidden;
        }
        #popup-header {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            border-bottom: 1px solid var(--border-color);
            cursor: move;
            user-select: none;
            background: var(--vscode-titleBar-activeBackground, #3c3c3c);
        }
        #popup-title {
            flex: 1;
            font-weight: 600;
            font-size: 13px;
        }
        #popup-close {
            width: 24px;
            height: 24px;
            border: none;
            background: transparent;
            color: var(--fg-color);
            cursor: pointer;
            font-size: 16px;
            border-radius: 3px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #popup-close:hover {
            background: var(--vscode-toolbar-hoverBackground, #5a5d5e);
        }
        #popup-content {
            flex: 1;
            overflow: auto;
            padding: 12px;
        }
        #popup-footer {
            display: flex;
            gap: 8px;
            padding: 8px 12px;
            border-top: 1px solid var(--border-color);
            justify-content: flex-end;
        }

        /* Form Fields */
        .form-group {
            margin-bottom: 12px;
        }
        .form-label {
            display: block;
            margin-bottom: 4px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground, #8b8b8b);
        }
        .form-input {
            width: 100%;
            padding: 6px 8px;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--fg-color);
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            border-radius: 3px;
            font-size: 13px;
            font-family: inherit;
        }
        .form-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder, #007fd4);
        }
        .form-input.error {
            border-color: var(--vscode-inputValidation-errorBorder, #f48771);
        }
        .form-select {
            width: 100%;
            padding: 6px 8px;
            background: var(--vscode-dropdown-background, #3c3c3c);
            color: var(--fg-color);
            border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
            border-radius: 3px;
            font-size: 13px;
        }
        .form-textarea {
            width: 100%;
            min-height: 60px;
            padding: 6px 8px;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--fg-color);
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            border-radius: 3px;
            font-size: 13px;
            font-family: inherit;
            resize: vertical;
        }
        .form-textarea:focus {
            outline: none;
            border-color: var(--vscode-focusBorder, #007fd4);
        }
        .form-hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #8b8b8b);
            margin-top: 2px;
        }
        .form-error {
            font-size: 11px;
            color: var(--vscode-inputValidation-errorForeground, #f48771);
            margin-top: 2px;
        }
        .form-checkbox {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
        }
        .form-checkbox input {
            width: 16px;
            height: 16px;
        }

        /* Array Field Styles */
        .array-field {
            margin-top: 4px;
        }
        .array-items {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-bottom: 8px;
        }
        .array-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            background: var(--vscode-input-background, #3c3c3c);
            border-radius: 3px;
        }
        .array-item-value {
            flex: 1;
            font-size: 12px;
        }
        .array-remove-btn {
            padding: 2px 6px !important;
            font-size: 14px;
        }
        .array-add-btn {
            font-size: 11px;
            padding: 2px 8px;
        }

        /* Object Field Styles */
        .object-field {
            margin-left: 12px;
            padding-left: 12px;
            border-left: 2px solid var(--border-color);
        }

        /* Connections Section */
        .connections-section {
            margin-top: 16px;
            border-top: 1px solid var(--border-color);
            padding-top: 12px;
        }
        .connections-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;
        }
        .connections-title {
            font-weight: 600;
            font-size: 12px;
        }
        .connection-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 0;
            font-size: 12px;
        }
        .connection-target {
            flex: 1;
        }
        .connection-label {
            color: var(--vscode-descriptionForeground, #8b8b8b);
        }
        .connection-actions {
            display: flex;
            gap: 4px;
        }
        .connection-btn {
            width: 20px;
            height: 20px;
            border: none;
            background: transparent;
            color: var(--fg-color);
            cursor: pointer;
            font-size: 12px;
            border-radius: 3px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .connection-btn:hover {
            background: var(--vscode-toolbar-hoverBackground, #5a5d5e);
        }

        /* Secondary Connection Popup */
        #connection-popup-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 22px;
            background: rgba(0, 0, 0, 0.5);
            z-index: 200; /* Higher than main popup */
        }
        #connection-popup-overlay.visible {
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #connection-popup-container {
            background: var(--bg-color);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
            width: 360px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
        }
        #connection-popup-header {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            border-bottom: 1px solid var(--border-color);
            background: var(--vscode-titleBar-activeBackground, #3c3c3c);
        }
        #connection-popup-title {
            flex: 1;
            font-weight: 600;
            font-size: 13px;
        }
        #connection-popup-close {
            width: 24px;
            height: 24px;
            border: none;
            background: transparent;
            color: var(--fg-color);
            cursor: pointer;
            font-size: 16px;
            border-radius: 3px;
        }
        #connection-popup-close:hover {
            background: var(--vscode-toolbar-hoverBackground, #5a5d5e);
        }
        #connection-popup-content {
            flex: 1;
            overflow: auto;
            padding: 12px;
        }
        #connection-popup-content .form-field {
            margin-bottom: 12px;
        }
        #connection-popup-content label {
            display: block;
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #8b8b8b);
            margin-bottom: 3px;
        }
        #connection-popup-content .form-input {
            width: 100%;
            box-sizing: border-box;
        }
        #connection-popup-footer {
            display: flex;
            gap: 8px;
            padding: 8px 12px;
            border-top: 1px solid var(--border-color);
            justify-content: flex-end;
        }

        ${baseCss}
        ${graphTypeCss}
    </style>
</head>
<body>
    <div id="layout">
        <div id="left-panel">
            <div id="sidebar-toolbar">
                <button class="toolbar-btn primary" id="btn-add-node" title="Add Node">+ Node</button>
                <button class="toolbar-btn" id="btn-duplicate" title="Duplicate Node" disabled>Duplicate</button>
                <button class="toolbar-btn" id="btn-delete" title="Delete Node" disabled>Delete</button>
                <span class="toolbar-spacer"></span>
            </div>
            <div id="doc-settings" class="collapsible-section">
                <div class="section-header" id="doc-settings-header">
                    <span class="section-toggle">▼</span>
                    <span class="section-title">Document Settings</span>
                </div>
                <div class="section-content" id="doc-settings-content">
                    <div class="form-field">
                        <label for="meta-id">ID</label>
                        <input type="text" id="meta-id" readonly class="form-input readonly" />
                    </div>
                    <div class="form-field">
                        <label for="meta-title">Title</label>
                        <input type="text" id="meta-title" class="form-input" placeholder="Document title" />
                    </div>
                    <div class="form-field">
                        <label for="meta-description">Description</label>
                        <textarea id="meta-description" class="form-input" rows="2" placeholder="Description"></textarea>
                    </div>
                    <div class="form-field" id="direction-field" style="display:none;">
                        <label for="meta-direction">Direction</label>
                        <select id="meta-direction" class="form-input">
                            <option value="TD">Top to Bottom (TD)</option>
                            <option value="LR">Left to Right (LR)</option>
                            <option value="BT">Bottom to Top (BT)</option>
                            <option value="RL">Right to Left (RL)</option>
                        </select>
                    </div>
                </div>
            </div>
            <div id="tree-container">
                <div id="tree">Loading tree...</div>
            </div>
        </div>
        <div id="resize-handle"></div>
        <div id="preview-container">
            <div id="zoom-controls">
                <button class="zoom-btn" id="zoom-in" title="Zoom In">+</button>
                <span id="zoom-level" title="Click to enter zoom level">100%</span>
                <button class="zoom-btn" id="zoom-out" title="Zoom Out">−</button>
                <button class="zoom-btn" id="zoom-fit" title="Fit to View">Fit</button>
                <button class="zoom-btn" id="zoom-reset" title="Reset Zoom">1:1</button>
            </div>
            <div id="mermaid-sizer">
                <div id="mermaid-wrapper">
                    <div id="mermaid-output">Loading diagram...</div>
                </div>
            </div>
        </div>
    </div>
    <div id="status-bar">
        <span id="status-text">Ready</span>
        <span id="error-count"></span>
    </div>

    <!-- Popup Overlay for Node Editor -->
    <div id="popup-overlay">
        <div id="popup-container">
            <div id="popup-header">
                <span id="popup-title">Edit Node</span>
                <button id="popup-close" title="Close (Esc)">\u00d7</button>
            </div>
            <div id="popup-content">
                <!-- Dynamic form content rendered here -->
            </div>
            <div id="popup-footer">
                <button class="toolbar-btn" id="popup-cancel">Cancel</button>
                <button class="toolbar-btn primary" id="popup-save">Save</button>
            </div>
        </div>
    </div>

    <!-- Secondary Popup for Connection Editor -->
    <div id="connection-popup-overlay">
        <div id="connection-popup-container">
            <div id="connection-popup-header">
                <span id="connection-popup-title">Edit Connection</span>
                <button id="connection-popup-close" title="Close">\u00d7</button>
            </div>
            <div id="connection-popup-content">
                <div class="form-field">
                    <label for="conn-target">To</label>
                    <select id="conn-target" class="form-input"></select>
                </div>
                <div class="form-field" id="conn-label-field">
                    <label for="conn-label">Label</label>
                    <input type="text" id="conn-label" class="form-input" placeholder="Connection label" />
                </div>
                <div class="form-field" id="conn-event-field" style="display:none;">
                    <label for="conn-event">Event</label>
                    <input type="text" id="conn-event" class="form-input" placeholder="Event name" />
                </div>
                <div class="form-field" id="conn-guard-field" style="display:none;">
                    <label for="conn-guard">Guard</label>
                    <input type="text" id="conn-guard" class="form-input" placeholder="Guard condition" />
                </div>
                <div class="form-field" id="conn-action-field" style="display:none;">
                    <label for="conn-action">Action</label>
                    <input type="text" id="conn-action" class="form-input" placeholder="Action to execute" />
                </div>
                <div class="form-field" id="conn-type-field" style="display:none;">
                    <label for="conn-type">Type</label>
                    <select id="conn-type" class="form-input">
                        <option value="one-to-one">One to One</option>
                        <option value="one-to-many">One to Many</option>
                        <option value="many-to-one">Many to One</option>
                        <option value="many-to-many">Many to Many</option>
                    </select>
                </div>
                <div class="form-field" id="conn-style-field">
                    <label for="conn-style">Style</label>
                    <select id="conn-style" class="form-input">
                        <option value="">Default</option>
                        <option value="dotted">Dotted</option>
                        <option value="thick">Thick</option>
                    </select>
                </div>
            </div>
            <div id="connection-popup-footer">
                <button class="toolbar-btn" id="connection-popup-cancel">Cancel</button>
                <button class="toolbar-btn primary" id="connection-popup-save">Save</button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscodeApi = acquireVsCodeApi();

        // Initialize Mermaid with dark theme and configs for all diagram types
        mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            securityLevel: 'loose',
            logLevel: 'error',  // Reduce noise but still show errors
            flowchart: { 
                htmlLabels: true, 
                curve: 'basis',
                useMaxWidth: false,  // Don't constrain width
            },
            state: {
                useMaxWidth: false,
            },
            stateDiagram: {
                useMaxWidth: false,
            },
            er: {
                useMaxWidth: false,
            },
        });

        let renderCounter = 0;
        let currentZoom = 1.0;
        const ZOOM_STEP = 0.05;
        const ZOOM_MIN = 0.1;
        const ZOOM_MAX = 5.0;

        function applyZoom() {
            const wrapper = document.getElementById('mermaid-wrapper');
            const sizer = document.getElementById('mermaid-sizer');
            if (wrapper) {
                wrapper.style.transform = 'scale(' + currentZoom + ')';
                // Update sizer to reflect scaled dimensions so scrollbars appear
                if (sizer) {
                    const output = document.getElementById('mermaid-output');
                    const svg = output?.querySelector('svg');
                    if (svg) {
                        const naturalW = svg.viewBox?.baseVal?.width || svg.clientWidth / currentZoom || svg.getBoundingClientRect().width / currentZoom;
                        const naturalH = svg.viewBox?.baseVal?.height || svg.clientHeight / currentZoom || svg.getBoundingClientRect().height / currentZoom;
                        sizer.style.width = Math.ceil(naturalW * currentZoom + 32) + 'px';
                        sizer.style.height = Math.ceil(naturalH * currentZoom + 32) + 'px';
                    }
                }
            }
            const label = document.getElementById('zoom-level');
            if (label) label.textContent = Math.round(currentZoom * 100) + '%';
        }

        function snapZoom(value) {
            // Snap to nearest 5% step
            return Math.round(value * 20) / 20;
        }

        document.getElementById('zoom-in')?.addEventListener('click', () => {
            currentZoom = snapZoom(Math.min(ZOOM_MAX, currentZoom + ZOOM_STEP));
            applyZoom();
        });
        document.getElementById('zoom-out')?.addEventListener('click', () => {
            currentZoom = snapZoom(Math.max(ZOOM_MIN, currentZoom - ZOOM_STEP));
            applyZoom();
        });

        // Clickable zoom percentage — turns into editable input on click
        // Use event delegation on the zoom-controls bar so re-created labels work
        document.getElementById('zoom-controls')?.addEventListener('click', (e) => {
            const label = e.target.closest('#zoom-level');
            if (!label) return;
            const currentPct = Math.round(currentZoom * 100);
            const input = document.createElement('input');
            input.id = 'zoom-input';
            input.type = 'text';
            input.value = String(currentPct);
            input.setAttribute('maxlength', '4');
            label.replaceWith(input);
            input.focus();
            input.select();

            let committed = false;
            function commit() {
                if (committed) return;
                committed = true;
                let val = parseInt(input.value, 10);
                if (!isNaN(val) && val >= Math.round(ZOOM_MIN*100) && val <= Math.round(ZOOM_MAX*100)) {
                    currentZoom = snapZoom(val / 100);
                }
                const newLabel = document.createElement('span');
                newLabel.id = 'zoom-level';
                newLabel.title = 'Click to enter zoom level';
                newLabel.textContent = Math.round(currentZoom * 100) + '%';
                input.replaceWith(newLabel);
                applyZoom();
            }

            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    committed = true;
                    const newLabel = document.createElement('span');
                    newLabel.id = 'zoom-level';
                    newLabel.title = 'Click to enter zoom level';
                    newLabel.textContent = Math.round(currentZoom * 100) + '%';
                    input.replaceWith(newLabel);
                }
            });
            input.addEventListener('blur', commit);
        });
        document.getElementById('zoom-reset')?.addEventListener('click', () => {
            currentZoom = 1.0;
            applyZoom();
        });
        document.getElementById('zoom-fit')?.addEventListener('click', () => {
            const container = document.getElementById('preview-container');
            const output = document.getElementById('mermaid-output');
            if (container && output) {
                const svg = output.querySelector('svg');
                if (svg) {
                    // Use getBBox() to get actual rendered content bounds
                    // This avoids invisible padding/elements that inflate viewBox
                    let svgW, svgH;
                    
                    try {
                        // getBBox() returns the tight bounding box of all visible content
                        const bbox = svg.getBBox();
                        if (bbox.width > 0 && bbox.height > 0) {
                            svgW = bbox.width + 20;  // small padding
                            svgH = bbox.height + 20;
                        }
                    } catch (e) {
                        // getBBox can fail if SVG not yet in DOM
                    }
                    
                    if (!svgW || !svgH) {
                        // Fallback: use width/height attributes
                        const attrW = parseFloat(svg.getAttribute('width') || '0');
                        const attrH = parseFloat(svg.getAttribute('height') || '0');
                        
                        if (attrW > 0 && attrH > 0) {
                            svgW = attrW;
                            svgH = attrH;
                        } else if (svg.viewBox?.baseVal?.width > 0) {
                            svgW = svg.viewBox.baseVal.width;
                            svgH = svg.viewBox.baseVal.height;
                        } else {
                            const rect = svg.getBoundingClientRect();
                            svgW = rect.width / currentZoom;
                            svgH = rect.height / currentZoom;
                        }
                    }
                    
                    const cW = container.clientWidth - 32;
                    const cH = container.clientHeight - 48;
                    
                    if (svgW > 0 && svgH > 0 && cW > 0 && cH > 0) {
                        currentZoom = Math.min(cW / svgW, cH / svgH, ZOOM_MAX);
                        currentZoom = Math.max(currentZoom, ZOOM_MIN);
                        applyZoom();
                    }
                }
            }
        });

        // Signal to extension host that the webview is ready
        vscodeApi.postMessage({ type: 'ready' });

        // Listen for messages from extension host
        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.type) {
                case 'updateAll':
                    handleUpdateAll(msg);
                    break;
                case 'selectNode':
                    handleSelectNode(msg.nodeId);
                    break;
                case 'highlightMermaidNode':
                    handleHighlightMermaidNode(msg.nodeId);
                    break;
                case 'showNode':
                    handleShowNode(msg);
                    break;
                case 'showErrors':
                    handleShowErrors(msg.errors);
                    break;
                case 'clearNodeEditor':
                    handleClearNodeEditor();
                    break;
            }
        });

        async function handleUpdateAll(msg) {
            // Extract node IDs from tree data for connection dropdown
            cachedNodeIds = [];
            function collectNodeIds(nodes) {
                if (!nodes) return;
                for (const node of nodes) {
                    // Skip meta and group nodes
                    if (node.id && !node.id.startsWith('__') && !node.id.startsWith('group-')) {
                        cachedNodeIds.push(node.id);
                    }
                    if (node.children) collectNodeIds(node.children);
                }
            }
            collectNodeIds(msg.treeData);

            // Detect graph type from mermaid source
            if (msg.mermaidSource) {
                if (msg.mermaidSource.startsWith('flowchart')) {
                    currentGraphType = 'flowchart';
                } else if (msg.mermaidSource.startsWith('stateDiagram')) {
                    currentGraphType = 'stateDiagram';
                } else if (msg.mermaidSource.startsWith('erDiagram')) {
                    currentGraphType = 'erDiagram';
                }
            }

            // Update tree
            const treeEl = document.getElementById('tree');
            if (treeEl) treeEl.innerHTML = renderTree(msg.treeData, true);

            // Render Mermaid diagram as SVG
            const previewEl = document.getElementById('mermaid-output');
            if (previewEl && msg.mermaidSource) {
                try {
                    renderCounter++;
                    const id = 'mermaid-svg-' + renderCounter;
                    const { svg } = await mermaid.render(id, msg.mermaidSource);
                    
                    if (!svg || svg.length < 100) {
                        previewEl.innerHTML = '<div style="padding:8px;color:#ffc107;">'
                            + '<strong>Warning: Empty or minimal SVG produced</strong><br>'
                            + '<pre style="white-space:pre-wrap;color:#d4d4d4;">' + escapeHtml(msg.mermaidSource) + '</pre>'
                            + '</div>';
                        return;
                    }
                    
                    previewEl.innerHTML = svg;
                    
                    // Post-process SVG: crop to actual content bounds.
                    // Mermaid can produce SVGs with inflated viewBox/dimensions,
                    // where background rects fill the whole canvas making the
                    // diagram appear tiny. We temporarily hide background rects,
                    // measure the real content, then resize the SVG.
                    setTimeout(() => {
                        const svgEl = previewEl.querySelector('svg');
                        if (svgEl) {
                            try {
                                // Temporarily hide elements that inflate the bbox:
                                // - background rects (class names vary by diagram type)
                                // - rects at position (0,0) spanning the full viewBox
                                const bgRects = [];
                                svgEl.querySelectorAll('rect').forEach(rect => {
                                    const cls = rect.getAttribute('class') || '';
                                    const fill = rect.getAttribute('fill') || '';
                                    const x = parseFloat(rect.getAttribute('x') || '0');
                                    const y = parseFloat(rect.getAttribute('y') || '0');
                                    // Hide background rects: those at origin with no meaningful class,
                                    // or with background-related classes, or transparent fills
                                    if ((x === 0 && y === 0 && !rect.closest('.node,.state,.entity,.cluster,.edgePath,.edgeLabel,.stateGroup,.entityBox')) ||
                                        cls.includes('background') || cls === 'er' ||
                                        fill === 'transparent' || fill === 'none') {
                                        bgRects.push({ el: rect, display: rect.style.display });
                                        rect.style.display = 'none';
                                    }
                                });
                                
                                // Now measure the content-only bounding box
                                const bbox = svgEl.getBBox();
                                
                                // Restore hidden rects
                                bgRects.forEach(r => r.el.style.display = r.display);
                                
                                if (bbox.width > 0 && bbox.height > 0) {
                                    const padding = 20;
                                    const newW = bbox.width + padding * 2;
                                    const newH = bbox.height + padding * 2;
                                    const newVB = (bbox.x - padding) + ' ' + (bbox.y - padding) + ' ' + newW + ' ' + newH;
                                    svgEl.setAttribute('viewBox', newVB);
                                    svgEl.setAttribute('width', String(Math.ceil(newW)));
                                    svgEl.setAttribute('height', String(Math.ceil(newH)));
                                    // Remove constraining styles Mermaid may set
                                    svgEl.style.maxWidth = '';
                                    svgEl.style.width = '';
                                    svgEl.style.height = '';
                                }
                            } catch (e) {
                                // getBBox can fail if SVG not yet laid out
                            }
                        }
                        // Auto-fit after cropping
                        document.getElementById('zoom-fit')?.click();
                        // Attach click handlers to SVG nodes
                        attachSvgClickHandlers();
                    }, 50);
                } catch (e) {
                    previewEl.innerHTML = '<div style="color:#f48771;padding:8px;">'
                        + '<strong>Mermaid render error:</strong><br>'
                        + '<pre style="white-space:pre-wrap;">' + escapeHtml(e.message || String(e)) + '</pre>'
                        + '<hr><strong>Source:</strong><br>'
                        + '<pre style="white-space:pre-wrap;color:#d4d4d4;">' + escapeHtml(msg.mermaidSource) + '</pre>'
                        + '</div>';
                    console.error('[YAML Graph] Mermaid render error:', e);
                }
            } else {
                if (previewEl && !msg.mermaidSource) {
                    previewEl.innerHTML = '<div style="color:#ffc107;padding:8px;">'
                        + '<strong>No Mermaid source received</strong><br>'
                        + '<em>Check that the YAML file has valid content and correct graph-version.</em>'
                        + '</div>';
                }
            }

            // Update status bar
            const errorCount = msg.errors?.length ?? 0;
            const errEl = document.getElementById('error-count');
            if (errEl) errEl.textContent = errorCount > 0
                ? errorCount + ' error(s)' : '';

            // Update Document Settings panel from YAML meta section
            updateDocumentSettings(msg.yamlText, msg.mermaidSource);
        }

        /**
         * Parse meta section from YAML and update Document Settings panel.
         * Uses simple regex parsing to avoid YAML library dependency in webview.
         */
        function updateDocumentSettings(yamlText, mermaidSource) {
            if (!yamlText) return;

            // Simple YAML meta parsing (safe for typical graph files)
            const metaMatch = yamlText.match(/^meta:\\s*\\n([\\s\\S]*?)(?=^[a-zA-Z_-]+:|$)/m);
            const metaBlock = metaMatch ? metaMatch[1] : '';

            const getValue = (key) => {
                const re = new RegExp('^\\\\s*' + key + ':\\\\s*(.+)$', 'm');
                const m = metaBlock.match(re);
                return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
            };

            // Populate fields
            const idEl = document.getElementById('meta-id');
            const titleEl = document.getElementById('meta-title');
            const descEl = document.getElementById('meta-description');
            const dirField = document.getElementById('direction-field');
            const dirEl = document.getElementById('meta-direction');

            if (idEl) idEl.value = getValue('id') || getValue('graph-type') || '';
            if (titleEl) titleEl.value = getValue('title') || '';
            if (descEl) descEl.value = getValue('description') || '';

            // Show direction dropdown for flowcharts
            const isFlowchart = mermaidSource && mermaidSource.startsWith('flowchart');
            if (dirField) dirField.style.display = isFlowchart ? 'block' : 'none';
            if (dirEl && isFlowchart) {
                const direction = getValue('direction') || 'TD';
                dirEl.value = direction;
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function renderTree(nodes, isRoot) {
            if (!nodes || nodes.length === 0) return '<em>No data</em>';
            const cls = isRoot ? 'style="list-style:none;padding-left:0;margin:4px 0;"' : 'class="tree-children"';
            return '<ul ' + cls + '>'
                + nodes.map(n => renderTreeNode(n)).join('') + '</ul>';
        }

        function renderTreeNode(node) {
            const safeId = escapeHtml(node.id);
            const safeLabel = escapeHtml(node.label);
            const hasChildren = node.children && node.children.length > 0;
            const toggle = hasChildren
                ? '<span class="tree-toggle" data-toggle="' + safeId + '">▼</span>'
                : '<span class="tree-indent"></span>';
            const childrenHtml = hasChildren ? renderTree(node.children, false) : '';
            return '<li>'
                + '<div class="tree-row" data-id="' + safeId + '">'
                + toggle
                + '<span class="tree-label">' + safeLabel + '</span>'
                + '</div>'
                + childrenHtml
                + '</li>';
        }

        // Use event delegation for tree clicks
        document.addEventListener('click', function(event) {
            // Handle collapse/expand toggle
            const toggleEl = event.target.closest('.tree-toggle');
            if (toggleEl) {
                event.stopPropagation();
                const li = toggleEl.closest('li');
                const childUl = li?.querySelector(':scope > .tree-children');
                if (childUl) {
                    childUl.classList.toggle('collapsed');
                    toggleEl.textContent = childUl.classList.contains('collapsed') ? '▶' : '▼';
                }
                return;
            }
            // Handle row selection
            const row = event.target.closest('.tree-row');
            if (row) {
                event.stopPropagation();
                const nodeId = row.dataset.id;
                if (nodeId) {
                    vscodeApi.postMessage({ type: 'treeNodeSelected', nodeId: nodeId });
                    // Visual selection
                    document.querySelectorAll('.tree-row.selected')
                        .forEach(el => el.classList.remove('selected'));
                    row.classList.add('selected');
                }
            }
        });

        // Drag-to-pan on the preview container
        // Only activates after a movement threshold to allow clicks through to nodes
        (function() {
            const container = document.getElementById('preview-container');
            if (!container) return;
            let isPanning = false;
            let didPan = false;
            let startX = 0, startY = 0;
            let scrollLeft0 = 0, scrollTop0 = 0;
            const PAN_THRESHOLD = 5; // pixels before panning starts

            container.addEventListener('mousedown', function(e) {
                // Only pan on left-click, not on zoom buttons or SVG node clicks
                if (e.button !== 0 || e.target.closest('#zoom-controls')) return;
                startX = e.clientX;
                startY = e.clientY;
                scrollLeft0 = container.scrollLeft;
                scrollTop0 = container.scrollTop;
                isPanning = true;
                didPan = false;
                // Don't preventDefault here — let clicks through
            });

            window.addEventListener('mousemove', function(e) {
                if (!isPanning) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                // Only start panning after threshold
                if (!didPan && Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) return;
                if (!didPan) {
                    didPan = true;
                    container.classList.add('panning');
                }
                container.scrollLeft = scrollLeft0 - dx;
                container.scrollTop = scrollTop0 - dy;
            });

            window.addEventListener('mouseup', function(e) {
                if (isPanning) {
                    isPanning = false;
                    container.classList.remove('panning');
                    // If we actually panned, prevent the click from firing on nodes
                    if (didPan) {
                        e.stopPropagation();
                    }
                    didPan = false;
                }
            });

            // Mousewheel zoom on the preview container
            container.addEventListener('wheel', function(e) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
                currentZoom = snapZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, currentZoom + delta)));
                applyZoom();
            }, { passive: false });
        })();

        // Draggable resize handle between tree panel and diagram
        (function() {
            const handle = document.getElementById('resize-handle');
            const leftPanel = document.getElementById('left-panel');
            if (!handle || !leftPanel) return;
            let isDragging = false;
            let startX = 0;
            let startWidth = 0;

            handle.addEventListener('mousedown', function(e) {
                isDragging = true;
                startX = e.clientX;
                startWidth = leftPanel.offsetWidth;
                handle.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });

            window.addEventListener('mousemove', function(e) {
                if (!isDragging) return;
                const dx = e.clientX - startX;
                const newWidth = Math.max(150, Math.min(startWidth + dx, window.innerWidth - 200));
                leftPanel.style.width = newWidth + 'px';
            });

            window.addEventListener('mouseup', function() {
                if (isDragging) {
                    isDragging = false;
                    handle.classList.remove('dragging');
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                }
            });
        })();

        // Register click handlers on SVG nodes after each render
        function attachSvgClickHandlers() {
            const output = document.getElementById('mermaid-output');
            if (!output) return;
            // Flowchart nodes: .node elements with id
            output.querySelectorAll('.node[id]').forEach(node => {
                node.addEventListener('click', function(e) {
                    e.stopPropagation();
                    // Mermaid prefixes node IDs; extract the actual key
                    // e.g. "flowchart-myNode-123" -> "myNode"
                    let nodeId = this.id;
                    const match = nodeId.match(/^flowchart-(.+?)(?:-\\d+)?$/);
                    if (match) nodeId = match[1];
                    vscodeApi.postMessage({ type: 'nodeClicked', nodeId: nodeId });
                });
            });
            // State diagram: .stateGroup or g with [id] inside state diagram
            output.querySelectorAll('[id*="state-"], .stateGroup[id]').forEach(node => {
                node.addEventListener('click', function(e) {
                    e.stopPropagation();
                    let nodeId = this.id.replace(/^state-/, '').replace(/-\\d+$/, '');
                    vscodeApi.postMessage({ type: 'nodeClicked', nodeId: nodeId });
                });
            });
            // ER diagram: .er elements (entity labels)
            output.querySelectorAll('.er.entityBox, .er.entityLabel').forEach(node => {
                const g = node.closest('g[id]');
                if (g) {
                    node.addEventListener('click', function(e) {
                        e.stopPropagation();
                        vscodeApi.postMessage({ type: 'nodeClicked', nodeId: g.id });
                    });
                }
            });
            // Also support Mermaid's built-in click callback
            if (typeof window.callback === 'undefined') {
                window.callback = function(nodeId) {
                    vscodeApi.postMessage({ type: 'nodeClicked', nodeId: nodeId });
                };
            }
        }

        function handleSelectNode(nodeId) {
            document.querySelectorAll('.tree-row.selected')
                .forEach(el => el.classList.remove('selected'));
            const el = document.querySelector('.tree-row[data-id="' + CSS.escape(nodeId) + '"]');
            if (el) el.classList.add('selected');
        }

        function handleHighlightMermaidNode(nodeId) {
            // Remove previous highlights
            document.querySelectorAll('.mermaid-highlight')
                .forEach(el => el.classList.remove('mermaid-highlight'));
            // Find and highlight the node in SVG
            const svgNode = document.getElementById(nodeId);
            if (svgNode) svgNode.classList.add('mermaid-highlight');
        }

        function handleShowNode(msg) {
            // Open popup editor for the selected node
            openNodePopup(msg.nodeId, msg.nodeData, msg.schema);
        }

        function handleShowErrors(errors) {
            const errEl = document.getElementById('error-count');
            if (errEl) errEl.textContent = errors.length > 0
                ? errors.length + ' error(s)' : '';
        }

        function handleClearNodeEditor() {
            // No longer used - popup closes itself
        }

        // ============================================
        // Popup Editor Management
        // ============================================

        let currentPopupNodeId = null;
        let currentPopupSchema = null;
        let currentNodeData = null;
        let popupGeometry = {}; // Store per-node geometry

        function openNodePopup(nodeId, nodeData, schema) {
            currentPopupNodeId = nodeId;
            currentNodeData = nodeData || {};
            currentPopupSchema = schema || [];

            const overlay = document.getElementById('popup-overlay');
            const container = document.getElementById('popup-container');
            const title = document.getElementById('popup-title');
            const content = document.getElementById('popup-content');

            title.textContent = 'Edit Node: ' + nodeId;
            content.innerHTML = renderNodeForm(nodeId, currentNodeData, currentPopupSchema);

            // Restore geometry if saved for this node
            if (popupGeometry[nodeId]) {
                const g = popupGeometry[nodeId];
                container.style.width = g.width + 'px';
                container.style.height = g.height + 'px';
            } else {
                container.style.width = '';
                container.style.height = '';
            }

            overlay.classList.add('visible');

            // Enable toolbar buttons
            document.getElementById('btn-duplicate').disabled = false;
            document.getElementById('btn-delete').disabled = false;

            // Focus first input
            const firstInput = content.querySelector('input, select, textarea');
            if (firstInput) firstInput.focus();
        }

        function closeNodePopup() {
            const overlay = document.getElementById('popup-overlay');
            const container = document.getElementById('popup-container');

            // Save geometry for this node
            if (currentPopupNodeId) {
                popupGeometry[currentPopupNodeId] = {
                    width: container.offsetWidth,
                    height: container.offsetHeight
                };
            }

            overlay.classList.remove('visible');
            currentPopupNodeId = null;
            currentNodeData = null;
            currentPopupSchema = null;

            // Disable toolbar buttons
            document.getElementById('btn-duplicate').disabled = true;
            document.getElementById('btn-delete').disabled = true;
        }

        function renderNodeForm(nodeId, nodeData, schema) {
            let html = '';

            // ID field (read-only with Change ID button)
            html += '<div class="form-group">';
            html += '<label class="form-label">ID</label>';
            html += '<div style="display:flex;gap:8px;">';
            html += '<input class="form-input" type="text" value="' + escapeHtml(nodeId) + '" readonly style="flex:1;background:var(--vscode-input-disabledBackground,#2d2d2d);">';
            html += '<button class="toolbar-btn" id="btn-change-id">Change ID</button>';
            html += '</div>';
            html += '</div>';

            // Render schema-driven fields
            if (schema && schema.length > 0) {
                for (const field of schema) {
                    html += renderFormField(field, nodeData);
                }
            } else {
                // Fallback: render basic fields
                html += renderBasicFields(nodeData);
            }

            // Connections section
            html += renderConnectionsSection(nodeData);

            return html;
        }

        /**
         * Get a nested value from an object using a dot-separated path.
         * e.g., getNestedValue(obj, 'metadata.owner') returns obj.metadata.owner
         */
        function getNestedValue(obj, path) {
            if (!obj || !path) return undefined;
            const parts = path.split('.');
            let current = obj;
            for (const part of parts) {
                if (current == null) return undefined;
                current = current[part];
            }
            return current;
        }

        /**
         * Render a form field based on FieldSchema from SchemaResolver.
         * Supports: string, number, boolean, enum, array, object field types.
         */
        function renderFormField(field, nodeData) {
            // FieldSchema interface: path, label, fieldType, required, description, xWidget
            // For enum: options[]
            // For array: itemSchema, minItems, maxItems
            // For object: properties[], allowAdditional
            const path = field.path;
            const value = getNestedValue(nodeData, path) ?? '';
            const label = field.label || path;
            const isRequired = field.required ? ' *' : '';

            let html = '<div class="form-group">';
            html += '<label class="form-label">' + escapeHtml(label) + escapeHtml(isRequired) + '</label>';

            switch (field.fieldType) {
                case 'enum':
                    html += '<select class="form-select" data-field="' + escapeHtml(path) + '">';
                    // Add empty option if not required
                    if (!field.required) {
                        const emptySelected = !value ? ' selected' : '';
                        html += '<option value=""' + emptySelected + '>(none)</option>';
                    }
                    if (field.options) {
                        for (const opt of field.options) {
                            const selected = opt === value ? ' selected' : '';
                            html += '<option value="' + escapeHtml(opt) + '"' + selected + '>' + escapeHtml(opt) + '</option>';
                        }
                    }
                    html += '</select>';
                    break;

                case 'boolean':
                    const checked = value ? ' checked' : '';
                    html += '<label class="form-checkbox"><input type="checkbox" data-field="' + escapeHtml(path) + '"' + checked + '> ' + escapeHtml(label) + '</label>';
                    // Remove the label we added above since it's in the checkbox label
                    html = html.replace('<label class="form-label">' + escapeHtml(label) + escapeHtml(isRequired) + '</label>', '');
                    break;

                case 'string':
                    if (field.multiline || path === 'description') {
                        html += '<textarea class="form-textarea" data-field="' + escapeHtml(path) + '">' + escapeHtml(String(value)) + '</textarea>';
                    } else {
                        html += '<input class="form-input" type="text" data-field="' + escapeHtml(path) + '" value="' + escapeHtml(String(value)) + '">';
                    }
                    break;

                case 'number':
                    let numAttrs = '';
                    if (field.minimum !== undefined) numAttrs += ' min="' + field.minimum + '"';
                    if (field.maximum !== undefined) numAttrs += ' max="' + field.maximum + '"';
                    html += '<input class="form-input" type="number" data-field="' + escapeHtml(path) + '" value="' + escapeHtml(String(value || '')) + '"' + numAttrs + '>';
                    break;

                case 'array':
                    html += renderArrayField(field, Array.isArray(value) ? value : []);
                    break;

                case 'object':
                    html += renderObjectField(field, value || {});
                    break;

                default:
                    // Fallback to text input
                    html += '<input class="form-input" type="text" data-field="' + escapeHtml(path) + '" value="' + escapeHtml(String(value)) + '">';
            }

            if (field.description) {
                html += '<div class="form-hint">' + escapeHtml(field.description) + '</div>';
            }

            html += '</div>';
            return html;
        }

        /**
         * Render an array field with add/remove buttons.
         */
        function renderArrayField(field, items) {
            let html = '<div class="array-field" data-field="' + escapeHtml(field.path) + '">';
            html += '<div class="array-items">';
            for (let i = 0; i < items.length; i++) {
                html += '<div class="array-item" data-index="' + i + '">';
                html += '<span class="array-item-value">' + escapeHtml(String(items[i] || '')) + '</span>';
                html += '<button class="connection-btn array-remove-btn" data-action="remove-array-item" data-index="' + i + '" title="Remove">×</button>';
                html += '</div>';
            }
            html += '</div>';
            html += '<button class="toolbar-btn array-add-btn" data-action="add-array-item" data-field="' + escapeHtml(field.path) + '">+ Add</button>';
            html += '</div>';
            return html;
        }

        /**
         * Render an object field as nested form fields.
         */
        function renderObjectField(field, value) {
            let html = '<div class="object-field">';
            if (field.properties && field.properties.length > 0) {
                for (const prop of field.properties) {
                    html += renderFormField(prop, value);
                }
            } else {
                html += '<div class="form-hint">(No properties defined)</div>';
            }
            html += '</div>';
            return html;
        }

        function renderBasicFields(nodeData) {
            let html = '';

            // Label
            html += '<div class="form-group">';
            html += '<label class="form-label">Label</label>';
            html += '<input class="form-input" type="text" data-field="label" value="' + escapeHtml(nodeData.label || '') + '">';
            html += '</div>';

            // Description
            html += '<div class="form-group">';
            html += '<label class="form-label">Description</label>';
            html += '<textarea class="form-textarea" data-field="description">' + escapeHtml(nodeData.description || '') + '</textarea>';
            html += '</div>';

            // Role (if exists)
            if (nodeData.role !== undefined) {
                html += '<div class="form-group">';
                html += '<label class="form-label">Role</label>';
                html += '<input class="form-input" type="text" data-field="role" value="' + escapeHtml(nodeData.role || '') + '">';
                html += '</div>';
            }

            // Shape (if exists)
            if (nodeData.shape !== undefined) {
                html += '<div class="form-group">';
                html += '<label class="form-label">Shape</label>';
                html += '<input class="form-input" type="text" data-field="shape" value="' + escapeHtml(nodeData.shape || '') + '">';
                html += '</div>';
            }

            return html;
        }

        function renderConnectionsSection(nodeData) {
            // Support both 'connections' (flowchart) and 'transitions' (state machine)
            const connections = nodeData.connections || nodeData.transitions || [];
            let html = '<div class="connections-section">';
            html += '<div class="connections-header">';
            html += '<span class="connections-title">Connections</span>';
            html += '<button class="toolbar-btn" id="btn-add-connection">+ Add</button>';
            html += '</div>';

            if (connections.length === 0) {
                html += '<div style="color:var(--vscode-descriptionForeground);font-size:12px;">No connections</div>';
            } else {
                for (let i = 0; i < connections.length; i++) {
                    const c = connections[i];
                    html += '<div class="connection-item" data-index="' + i + '">';
                    html += '<span class="connection-target">→ ' + escapeHtml(c.to || c.target || '') + '</span>';
                    if (c.label) {
                        html += '<span class="connection-label">[' + escapeHtml(c.label) + ']</span>';
                    }
                    html += '<div class="connection-actions">';
                    html += '<button class="connection-btn" data-action="edit" data-index="' + i + '" title="Edit">✎</button>';
                    html += '<button class="connection-btn" data-action="delete" data-index="' + i + '" title="Delete">×</button>';
                    html += '</div>';
                    html += '</div>';
                }
            }

            html += '</div>';
            return html;
        }

        /**
         * Set a nested value in an object using a dot-separated path.
         * Creates intermediate objects as needed.
         */
        function setNestedValue(obj, path, value) {
            const parts = path.split('.');
            let current = obj;
            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i];
                if (current[part] === undefined || current[part] === null) {
                    current[part] = {};
                }
                current = current[part];
            }
            current[parts[parts.length - 1]] = value;
        }

        function collectFormData() {
            // Deep clone to avoid mutating original
            const data = JSON.parse(JSON.stringify(currentNodeData || {}));
            const content = document.getElementById('popup-content');

            content.querySelectorAll('[data-field]').forEach(el => {
                const path = el.dataset.field;
                let value;
                if (el.type === 'checkbox') {
                    value = el.checked;
                } else if (el.type === 'number') {
                    value = el.value === '' ? undefined : parseFloat(el.value);
                } else {
                    value = el.value;
                }
                setNestedValue(data, path, value);
            });

            return data;
        }

        // Popup event handlers
        document.getElementById('popup-close')?.addEventListener('click', closeNodePopup);
        document.getElementById('popup-cancel')?.addEventListener('click', closeNodePopup);

        document.getElementById('popup-save')?.addEventListener('click', () => {
            if (!currentPopupNodeId) return;
            const data = collectFormData();
            vscodeApi.postMessage({
                type: 'applyEdit',
                nodeId: currentPopupNodeId,
                edits: Object.keys(data).map(key => ({ path: key, value: data[key] }))
            });
            closeNodePopup();
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.getElementById('popup-overlay')?.classList.contains('visible')) {
                closeNodePopup();
            }
        });

        // Close on overlay click (outside popup)
        document.getElementById('popup-overlay')?.addEventListener('click', (e) => {
            if (e.target.id === 'popup-overlay') {
                closeNodePopup();
            }
        });

        // Popup dragging
        (function() {
            const header = document.getElementById('popup-header');
            const container = document.getElementById('popup-container');
            if (!header || !container) return;

            let isDragging = false;
            let startX = 0, startY = 0;
            let startLeft = 0, startTop = 0;

            header.addEventListener('mousedown', (e) => {
                if (e.target.id === 'popup-close') return;
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                const rect = container.getBoundingClientRect();
                startLeft = rect.left;
                startTop = rect.top;
                container.style.position = 'fixed';
                container.style.margin = '0';
                e.preventDefault();
            });

            window.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                container.style.left = (startLeft + dx) + 'px';
                container.style.top = (startTop + dy) + 'px';
            });

            window.addEventListener('mouseup', () => {
                isDragging = false;
            });
        })();

        // ============================================
        // Toolbar Button Handlers
        // ============================================

        document.getElementById('btn-add-node')?.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'requestAddNode' });
        });

        document.getElementById('btn-duplicate')?.addEventListener('click', () => {
            if (currentPopupNodeId) {
                vscodeApi.postMessage({
                    type: 'requestDuplicateNode',
                    sourceNodeId: currentPopupNodeId
                });
            }
        });

        document.getElementById('btn-delete')?.addEventListener('click', () => {
            if (currentPopupNodeId) {
                if (confirm('Delete node "' + currentPopupNodeId + '"?')) {
                    vscodeApi.postMessage({
                        type: 'requestDeleteNode',
                        nodeId: currentPopupNodeId
                    });
                    closeNodePopup();
                }
            }
        });

        // Change ID handler (inside popup)
        document.getElementById('popup-content')?.addEventListener('click', (e) => {
            if (e.target.id === 'btn-change-id') {
                const newId = prompt('Enter new ID:', currentPopupNodeId);
                if (newId && newId !== currentPopupNodeId && /^[a-z][a-z0-9-]*$/.test(newId)) {
                    vscodeApi.postMessage({
                        type: 'requestRenameNode',
                        oldId: currentPopupNodeId,
                        newId: newId
                    });
                    closeNodePopup();
                } else if (newId && !/^[a-z][a-z0-9-]*$/.test(newId)) {
                    alert('Invalid ID. Must start with lowercase letter and contain only lowercase letters, numbers, and hyphens.');
                }
            }

            // Connection actions
            const btn = e.target.closest('.connection-btn');
            if (btn) {
                const action = btn.dataset.action;
                const index = parseInt(btn.dataset.index, 10);
                if (action === 'edit') {
                    // Open connection popup with current data
                    const connArrayName = (currentGraphType === 'stateDiagram' || currentGraphType === 'state') 
                        ? 'transitions' 
                        : 'connections';
                    const connections = currentNodeData[connArrayName] || [];
                    const connectionData = connections[index] || {};
                    openConnectionPopup(index, connectionData);
                } else if (action === 'delete') {
                    if (confirm('Delete this connection?')) {
                        vscodeApi.postMessage({
                            type: 'requestDeleteConnection',
                            nodeId: currentPopupNodeId,
                            connectionIndex: index
                        });
                    }
                }
            }

            // Add connection button
            if (e.target.id === 'btn-add-connection') {
                // Open connection popup for new connection
                openConnectionPopup(-1, null);
            }
        });

        // ============================================
        // Document Settings Handlers
        // ============================================

        // Collapse/expand toggle
        document.getElementById('doc-settings-header')?.addEventListener('click', () => {
            const toggle = document.querySelector('#doc-settings-header .section-toggle');
            const content = document.getElementById('doc-settings-content');
            if (toggle && content) {
                toggle.classList.toggle('collapsed');
                content.classList.toggle('collapsed');
            }
        });

        // Meta field change handlers (debounced)
        let metaDebounceTimer = null;
        function sendMetaEdit(path, value) {
            clearTimeout(metaDebounceTimer);
            metaDebounceTimer = setTimeout(() => {
                vscodeApi.postMessage({
                    type: 'applyEdit',
                    nodeId: '__meta__',
                    edits: [{ path: path, value: value }]
                });
            }, 300);
        }

        document.getElementById('meta-title')?.addEventListener('input', (e) => {
            sendMetaEdit('meta.title', e.target.value);
        });

        document.getElementById('meta-description')?.addEventListener('input', (e) => {
            sendMetaEdit('meta.description', e.target.value);
        });

        document.getElementById('meta-direction')?.addEventListener('change', (e) => {
            sendMetaEdit('meta.direction', e.target.value);
            // Also send changeDirection for immediate re-render
            vscodeApi.postMessage({ type: 'changeDirection', direction: e.target.value });
        });

        // ============================================
        // Connection Editor Secondary Popup
        // ============================================

        let currentConnectionIndex = -1;
        let currentGraphType = 'flowchart'; // Will be inferred from mermaid source
        let cachedNodeIds = []; // List of node IDs for dropdown

        /**
         * Open the connection editor popup.
         * @param {number} index - Index of connection to edit (-1 for new connection)
         * @param {object} connectionData - Current connection data (null for new)
         */
        function openConnectionPopup(index, connectionData) {
            currentConnectionIndex = index;
            
            const overlay = document.getElementById('connection-popup-overlay');
            const title = document.getElementById('connection-popup-title');
            
            title.textContent = index === -1 ? 'Add Connection' : 'Edit Connection';
            
            // Populate the target dropdown with node IDs
            const targetSelect = document.getElementById('conn-target');
            targetSelect.innerHTML = cachedNodeIds
                .filter(id => id !== currentPopupNodeId) // Exclude current node
                .map(id => '<option value="' + escapeHtml(id) + '">' + escapeHtml(id) + '</option>')
                .join('');
            
            // Show/hide fields based on graph type
            showConnectionFields();
            
            // Populate fields if editing
            if (connectionData) {
                if (connectionData.to) targetSelect.value = connectionData.to;
                document.getElementById('conn-label').value = connectionData.label || '';
                document.getElementById('conn-event').value = connectionData.event || '';
                document.getElementById('conn-guard').value = connectionData.guard || '';
                document.getElementById('conn-action').value = connectionData.action || '';
                document.getElementById('conn-type').value = connectionData.type || 'one-to-one';
                document.getElementById('conn-style').value = connectionData.style || '';
                
                // Make target read-only when editing
                targetSelect.disabled = true;
            } else {
                // Clear fields for new connection
                document.getElementById('conn-label').value = '';
                document.getElementById('conn-event').value = '';
                document.getElementById('conn-guard').value = '';
                document.getElementById('conn-action').value = '';
                document.getElementById('conn-type').value = 'one-to-one';
                document.getElementById('conn-style').value = '';
                targetSelect.disabled = false;
            }
            
            overlay.classList.add('visible');
        }

        function closeConnectionPopup() {
            const overlay = document.getElementById('connection-popup-overlay');
            overlay.classList.remove('visible');
            currentConnectionIndex = -1;
        }

        function showConnectionFields() {
            // Show/hide fields based on graph type
            const isFlowchart = currentGraphType === 'flowchart';
            const isStateMachine = currentGraphType === 'stateDiagram' || currentGraphType === 'state';
            const isER = currentGraphType === 'erDiagram' || currentGraphType === 'er';
            
            document.getElementById('conn-label-field').style.display = (isFlowchart || isER) ? 'block' : 'none';
            document.getElementById('conn-event-field').style.display = isStateMachine ? 'block' : 'none';
            document.getElementById('conn-guard-field').style.display = isStateMachine ? 'block' : 'none';
            document.getElementById('conn-action-field').style.display = isStateMachine ? 'block' : 'none';
            document.getElementById('conn-type-field').style.display = isER ? 'block' : 'none';
            document.getElementById('conn-style-field').style.display = isFlowchart ? 'block' : 'none';
        }

        function saveConnectionEdit() {
            const targetSelect = document.getElementById('conn-target');
            const targetValue = targetSelect.value;
            
            if (!targetValue) {
                alert('Please select a target node.');
                return;
            }
            
            // Build connection data based on graph type
            const connectionData = { to: targetValue };
            
            if (currentGraphType === 'flowchart') {
                const label = document.getElementById('conn-label').value;
                const style = document.getElementById('conn-style').value;
                if (label) connectionData.label = label;
                if (style) connectionData.style = style;
            } else if (currentGraphType === 'stateDiagram' || currentGraphType === 'state') {
                const event = document.getElementById('conn-event').value;
                const guard = document.getElementById('conn-guard').value;
                const action = document.getElementById('conn-action').value;
                if (event) connectionData.event = event;
                if (guard) connectionData.guard = guard;
                if (action) connectionData.action = action;
            } else if (currentGraphType === 'erDiagram' || currentGraphType === 'er') {
                const type = document.getElementById('conn-type').value;
                const label = document.getElementById('conn-label').value;
                if (type) connectionData.type = type;
                if (label) connectionData.label = label;
            }
            
            // Determine connections array name
            const connArrayName = (currentGraphType === 'stateDiagram' || currentGraphType === 'state') 
                ? 'transitions' 
                : 'connections';
            
            // Get current connections array from node data
            let connections = currentNodeData[connArrayName] || [];
            connections = Array.isArray(connections) ? [...connections] : [];
            
            if (currentConnectionIndex === -1) {
                // Add new connection
                connections.push(connectionData);
            } else {
                // Update existing connection
                connections[currentConnectionIndex] = connectionData;
            }
            
            // Send edit to extension
            vscodeApi.postMessage({
                type: 'applyEdit',
                nodeId: currentPopupNodeId,
                edits: [{ path: connArrayName, value: connections }]
            });
            
            closeConnectionPopup();
        }

        // Connection popup event handlers
        document.getElementById('connection-popup-close')?.addEventListener('click', closeConnectionPopup);
        document.getElementById('connection-popup-cancel')?.addEventListener('click', closeConnectionPopup);
        document.getElementById('connection-popup-save')?.addEventListener('click', saveConnectionEdit);
        document.getElementById('connection-popup-overlay')?.addEventListener('click', (e) => {
            if (e.target.id === 'connection-popup-overlay') closeConnectionPopup();
        });

        // Hook into connection edit button clicks
        // (already handled in popup-content click handler, but we need to open the connection popup)
        // Let's modify the edit action handler to open the popup
    </script>
</body>
</html>`;
    }

    /**
     * Generate a random nonce for Content Security Policy.
     */
    private generateNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let nonce = '';
        for (let i = 0; i < 32; i++) {
            nonce += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return nonce;
    }

    /**
     * Escape HTML special characters for safe embedding.
     */
    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Get the underlying webview panel (for disposal/lifecycle management).
     */
    getPanel(): vscode.WebviewPanel {
        return this.panel;
    }
}
