/**
 * SourceSyncManager — opens the YAML source file in a side-by-side
 * VS Code text editor and keeps tree ↔ source selections synchronised.
 *
 * Tree/diagram → source:
 *   SelectionCoordinator already calls `revealInEditor` when a node is
 *   selected. SourceSyncManager ensures a text editor is visible for
 *   the document so that `revealInEditor` has somewhere to target.
 *
 * Source → tree:
 *   Listens to `onDidChangeTextEditorSelection` and uses
 *   `YamlParserWrapper.findNodeAtOffset` to determine which node the
 *   cursor is inside, then sends a `selectNode` message to the webview.
 */

import * as vscode from 'vscode';
import { YamlParserWrapper } from 'yaml-graph-core';
import type { WebviewManager } from './webview-manager.js';

export class SourceSyncManager {
    private readonly parser = new YamlParserWrapper();
    private textEditor: vscode.TextEditor | undefined;
    private selectionDisposable: vscode.Disposable | undefined;
    private editorCloseDisposable: vscode.Disposable | undefined;
    private lastSyncedNodeId: string | undefined;
    /** When true, ignore the next selection change (caused by our own revealInEditor). */
    private suppressNextSelection = false;
    private readonly nodesPath: string;

    constructor(
        private readonly document: vscode.TextDocument,
        private readonly webview: WebviewManager,
        nodesPath?: string,
    ) {
        this.nodesPath = nodesPath ?? 'nodes';
    }

    /**
     * Open the document in a regular VS Code text editor beside the custom editor.
     * Returns the text editor, or undefined if it failed.
     */
    async openSideBySide(): Promise<vscode.TextEditor | undefined> {
        try {
            this.textEditor = await vscode.window.showTextDocument(
                this.document,
                {
                    viewColumn: vscode.ViewColumn.Beside,
                    preserveFocus: true, // keep focus on graphic editor
                    preview: false,      // non-preview tab
                }
            );

            // Track if the text editor gets closed/replaced
            this.editorCloseDisposable = vscode.window.onDidChangeVisibleTextEditors(() => {
                this.refreshEditorRef();
            });

            // Start listening for cursor changes
            this.startCursorSync();

            return this.textEditor;
        } catch {
            // Non-fatal — user can still use the graph editor without source
            return undefined;
        }
    }

    /**
     * Refresh the stored editor reference by searching visible editors.
     */
    private refreshEditorRef(): void {
        const docUri = this.document.uri.toString();
        const found = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === docUri
        );
        this.textEditor = found;
    }

    /**
     * Reveal a tree item's YAML source in the text editor.
     * Maps tree IDs to YAML paths and scrolls/selects the range.
     *
     * Tree ID patterns:
     * - "checkout"          → nodes.checkout (node ID)
     * - "__meta__"          → meta
     * - "__meta__.title"    → meta.title
     * - "__nodes__"         → nodes
     * - "__edges__"         → edges
     * - "__edge_3"          → edges.3
     * - "checkout.tags"     → nodes.checkout.tags
     * - "checkout.tags[1]"  → nodes.checkout.tags.1
     */
    revealTreeItem(treeId: string): void {
        const yamlPath = this.treeIdToYamlPath(treeId);
        if (!yamlPath) return;

        // Ensure we have a live editor reference
        if (!this.textEditor) this.refreshEditorRef();
        if (!this.textEditor) return;

        try {
            const parsed = this.parser.parse(this.document.getText());

            // Try getMapEntryRange first (covers full key+value block), fall back to getSourceRange
            let range = this.parser.getMapEntryRange(parsed, yamlPath)
                     ?? this.parser.getSourceRange(parsed, yamlPath);

            if (range) {
                this.suppressNextSelection = true;

                const startPos = this.document.positionAt(range.startOffset);
                const endPos = this.document.positionAt(range.endOffset);
                const vsRange = new vscode.Range(startPos, endPos);

                this.textEditor.revealRange(vsRange, vscode.TextEditorRevealType.InCenter);
                this.textEditor.selection = new vscode.Selection(startPos, startPos);
            }
        } catch {
            // YAML might be invalid — ignore
        }
    }

    /**
     * Map a tree node ID to the YAML dot-path for source lookup.
     */
    private treeIdToYamlPath(treeId: string): string | undefined {
        // Group headers
        if (treeId === '__meta__') return 'meta';
        if (treeId === '__nodes__') return 'nodes';
        if (treeId === '__edges__') return 'edges';

        // Meta fields: __meta__.title → meta.title
        if (treeId.startsWith('__meta__.')) {
            return 'meta.' + treeId.slice('__meta__.'.length);
        }

        // Edge items: __edge_3 → edges.3
        const edgeMatch = treeId.match(/^__edge_(\d+)$/);
        if (edgeMatch) {
            return 'edges.' + edgeMatch[1];
        }

        // Node sub-properties: checkout.tags → nodes.checkout.tags
        // Node sub-property array items: checkout.tags[1] → nodes.checkout.tags.1
        if (treeId.includes('.')) {
            return 'nodes.' + treeId.replace(/\[(\d+)\]/g, '.$1');
        }

        // Plain node ID: checkout → nodes.checkout
        return 'nodes.' + treeId;
    }

    /**
     * Temporarily suppress the next source → tree sync.
     * Call this just before programmatically setting a selection in the text editor
     * (e.g., from tree → source) to avoid a feedback loop.
     */
    suppressNext(): void {
        this.suppressNextSelection = true;
    }

    /**
     * Start listening for text editor cursor changes.
     * Determines which node the cursor is inside and syncs to the tree.
     */
    private startCursorSync(): void {
        this.selectionDisposable?.dispose();

        this.selectionDisposable = vscode.window.onDidChangeTextEditorSelection((e) => {
            // Only respond to selections in our document
            if (e.textEditor.document.uri.toString() !== this.document.uri.toString()) {
                return;
            }

            // Skip if we caused this selection change ourselves
            if (this.suppressNextSelection) {
                this.suppressNextSelection = false;
                return;
            }

            // Only respond to cursor changes, not programmatic selections
            if (e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard &&
                e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
                return;
            }

            const offset = this.document.offsetAt(e.selections[0].active);
            this.syncFromOffset(offset);
        });
    }

    /**
     * Given a character offset in the YAML source, find the containing node
     * and sync the tree + diagram selection.
     */
    private syncFromOffset(offset: number): void {
        try {
            const parsed = this.parser.parse(this.document.getText());
            const nodeId = this.parser.findNodeAtOffset(parsed, offset, this.nodesPath);

            if (nodeId && nodeId !== this.lastSyncedNodeId) {
                this.lastSyncedNodeId = nodeId;
                // Update tree and diagram highlights in the webview
                this.webview.postMessage({ type: 'selectNode', nodeId });
                this.webview.postMessage({ type: 'highlightMermaidNode', nodeId });
            }
        } catch {
            // YAML might be temporarily invalid while editing — ignore
        }
    }

    /**
     * Dispose of all listeners.
     */
    dispose(): void {
        this.selectionDisposable?.dispose();
        this.editorCloseDisposable?.dispose();
    }
}
