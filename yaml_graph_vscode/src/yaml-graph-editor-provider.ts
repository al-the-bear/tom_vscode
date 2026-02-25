/**
 * YamlGraphEditorProvider — VS Code CustomTextEditorProvider that
 * manages the YAML Graph Editor experience.
 *
 * This is the main entry point registered with VS Code. It:
 * - Resolves the correct graph type for each document
 * - Creates the webview with tree, preview, and node editor
 * - Coordinates document changes with webview updates (debounced)
 * - Delegates message handling to SelectionCoordinator
 */

import * as vscode from 'vscode';
import {
    ConversionEngine, GraphTypeRegistry,
    type ConversionCallbacks, type GraphType
} from 'yaml-graph-core';
import { parse as parseYaml } from 'yaml';
import { WebviewManager } from './webview-manager.js';
import { SelectionCoordinator } from './selection-coordinator.js';
import { TreeDataBuilder } from './tree-data-builder.js';
import { NodeEditorController } from './node-editor-controller.js';
import { SourceSyncManager } from './source-sync-manager.js';

/** Default debounce delay for document change → webview update (ms). */
const DEFAULT_DEBOUNCE_MS = 1000;

export class YamlGraphEditorProvider implements vscode.CustomTextEditorProvider {
    private engine: ConversionEngine;
    private registry: GraphTypeRegistry;
    private callbacks: ConversionCallbacks;
    private treeBuilder: TreeDataBuilder;
    private nodeEditor: NodeEditorController;
    private debounceMs: number;

    constructor(
        engine: ConversionEngine,
        registry: GraphTypeRegistry,
        callbacks: ConversionCallbacks,
        options?: {
            treeBuilder?: TreeDataBuilder;
            nodeEditor?: NodeEditorController;
            debounceMs?: number;
        }
    ) {
        this.engine = engine;
        this.registry = registry;
        this.callbacks = callbacks;
        this.treeBuilder = options?.treeBuilder ?? new TreeDataBuilder();
        this.nodeEditor = options?.nodeEditor ?? new NodeEditorController();
        this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    }

    /**
     * Called by VS Code when a YAML graph file is opened with the custom editor.
     */
    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // Resolve graph type for this document
        const graphType = this.resolveGraphType(document);
        if (!graphType) {
            return; // Error message already shown
        }

        // Set up webview manager
        const webview = new WebviewManager(webviewPanel, graphType);

        // Set up selection coordinator
        const coordinator = new SelectionCoordinator(
            webview, this.nodeEditor, graphType
        );

        // Open source editor side-by-side and wire bidirectional sync
        const sourceSync = new SourceSyncManager(document, webview);
        coordinator.setSourceSync(sourceSync);
        await sourceSync.openSideBySide();

        // Handle messages from webview
        webview.onMessage((msg) => {
            coordinator.handleWebviewMessage(msg, document);
        });

        // Wait for webview script to load before sending initial data
        await webview.waitForReady();

        // Initial render
        await this.updateWebview(document, graphType, webview);

        // Listen for document changes (debounced)
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        const changeListener = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    this.updateWebview(document, graphType, webview);
                }, this.debounceMs);
            }
        });

        // Cleanup on panel dispose
        webviewPanel.onDidDispose(() => {
            changeListener.dispose();
            sourceSync.dispose();
            clearTimeout(debounceTimer);
        });
    }

    /**
     * Convert the document and update the webview with results.
     */
    async updateWebview(
        document: vscode.TextDocument,
        graphType: GraphType,
        webview: WebviewManager
    ): Promise<void> {
        const yamlText = document.getText();

        // Tell callbacks which mermaid type we're rendering (controls click support)
        if ('setMermaidType' in this.callbacks) {
            (this.callbacks as any).setMermaidType(graphType.mapping.map.mermaidType);
        }

        const result = await this.engine.convertWithPrepare(
            yamlText, graphType, this.callbacks
        );

        // Build tree data from the parsed YAML
        let treeData: import('./types.js').TreeNode[] = [];
        try {
            const data = parseYaml(yamlText);
            treeData = this.treeBuilder.buildTree(data, graphType);
        } catch {
            treeData = [];
        }

        webview.update(yamlText, result.mermaidSource, treeData, result.errors);
    }

    /**
     * Resolve the graph type for a document.
     *
     * The `meta.graph-version` field is **required** in every YAML data file.
     * Missing or non-numeric values produce an error.
     */
    resolveGraphType(document: vscode.TextDocument): GraphType | undefined {
        try {
            const text = document.getText();
            const data = parseYaml(text);

            if (!data || typeof data !== 'object') {
                vscode.window.showErrorMessage(
                    `Cannot parse ${document.fileName} as YAML.`
                );
                return undefined;
            }

            const requestedVersion = data?.meta?.['graph-version'];

            if (typeof requestedVersion !== 'number') {
                vscode.window.showErrorMessage(
                    `Missing required 'meta.graph-version' field in ${document.fileName}. ` +
                    `Add a numeric graph-version to the meta section.`
                );
                return undefined;
            }

            const graphType = this.registry.getForFileVersion(
                document.fileName, requestedVersion
            );
            if (!graphType) {
                vscode.window.showErrorMessage(
                    `No graph type version ${requestedVersion} registered ` +
                    `for ${document.fileName}.`
                );
            }
            return graphType;
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to parse ${document.fileName}: ${(err as Error).message}`
            );
            return undefined;
        }
    }
}
