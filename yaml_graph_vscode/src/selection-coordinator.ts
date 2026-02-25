/**
 * SelectionCoordinator — coordinates selection state across all panes:
 * tree panel, Mermaid preview, YAML text editor, and node editor.
 *
 * When a node is selected in any pane, the coordinator updates all other
 * panes to reflect the selection. This provides the unified selection
 * experience described in the architecture.
 */

import * as vscode from 'vscode';
import { YamlParserWrapper } from 'yaml-graph-core';
import type { GraphType } from 'yaml-graph-core';
import type { WebviewManager } from './webview-manager.js';
import type { NodeEditorController } from './node-editor-controller.js';
import type { WebviewMessage, NodeEditRequest } from './types.js';
import type { SourceSyncManager } from './source-sync-manager.js';

export class SelectionCoordinator {
    private parser = new YamlParserWrapper();
    private currentNodeId: string | undefined;
    private sourceSync: SourceSyncManager | undefined;

    constructor(
        private readonly webview: WebviewManager,
        private readonly nodeEditor: NodeEditorController,
        private readonly graphType: GraphType
    ) {}

    /**
     * Get the currently selected node ID.
     */
    getSelectedNodeId(): string | undefined {
        return this.currentNodeId;
    }

    /**
     * Set the SourceSyncManager for bidirectional sync.
     * Call this after constructing the coordinator.
     */
    setSourceSync(sourceSync: SourceSyncManager): void {
        this.sourceSync = sourceSync;
    }

    /**
     * Handle an incoming message from the webview.
     * Dispatches to the appropriate handler based on message type.
     */
    handleWebviewMessage(msg: WebviewMessage, document: vscode.TextDocument): void {
        switch (msg.type) {
            case 'nodeClicked':
            case 'treeNodeSelected':
                this.onNodeSelected(msg.nodeId, document);
                break;
            case 'applyEdit':
                this.onApplyEdit({
                    nodeId: msg.nodeId,
                    changes: Object.fromEntries(msg.edits.map(e => [e.path, e.value])),
                }, document);
                break;
            case 'requestAddNode':
                this.onRequestAddNode(document);
                break;
            case 'requestDuplicateNode':
                this.onRequestDuplicateNode(msg.sourceNodeId, document);
                break;
            case 'requestDeleteNode':
                this.onRequestDeleteNode(msg.nodeId, document);
                break;
            case 'requestRenameNode':
                this.onRequestRenameNode(msg.oldId, msg.newId, document);
                break;
            case 'requestAddConnection':
                this.onRequestAddConnection(msg.nodeId, document);
                break;
            case 'requestDeleteConnection':
                this.onRequestDeleteConnection(msg.nodeId, msg.connectionIndex, document);
                break;
        }
    }

    /**
     * Handle node selection from any source (tree click, diagram click).
     * Updates all panes: tree highlight, Mermaid highlight, YAML cursor, node editor.
     */
    onNodeSelected(nodeId: string, document: vscode.TextDocument): void {
        this.currentNodeId = nodeId;

        // 1. Highlight in tree
        this.webview.postMessage({ type: 'selectNode', nodeId });

        // 2. Highlight in Mermaid preview
        this.webview.postMessage({ type: 'highlightMermaidNode', nodeId });

        // 3. Reveal in YAML text editor (via SourceSyncManager for reliable reference)
        if (this.sourceSync) {
            this.sourceSync.revealTreeItem(nodeId);
        } else {
            this.revealInEditor(nodeId, document);
        }

        // 4. Update node editor panel
        this.updateNodeEditor(nodeId, document);
    }

    /**
     * Reveal a node's YAML source in the text editor.
     * Scrolls to the node's position and selects its range.
     * Suppresses source→tree feedback loop via SourceSyncManager.
     */
    revealInEditor(nodeId: string, document: vscode.TextDocument): void {
        const parsed = this.parser.parse(document.getText());
        const range = this.parser.getSourceRange(parsed, `nodes.${nodeId}`);

        if (range) {
            // Suppress the source→tree sync that our own selection change would trigger
            this.sourceSync?.suppressNext();

            const startPos = document.positionAt(range.startOffset);
            const endPos = document.positionAt(range.endOffset);
            const vsRange = new vscode.Range(startPos, endPos);

            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document.uri.toString() === document.uri.toString()) {
                    editor.revealRange(vsRange, vscode.TextEditorRevealType.InCenter);
                    editor.selection = new vscode.Selection(startPos, endPos);
                }
            }
        }
    }

    /**
     * Update the node editor with data for the selected node.
     */
    updateNodeEditor(nodeId: string, document: vscode.TextDocument): void {
        const parsed = this.parser.parse(document.getText());
        const data = parsed.data as Record<string, unknown> | undefined;
        const nodes = data?.['nodes'] as Record<string, unknown> | undefined;
        const nodeData = nodes?.[nodeId];

        if (nodeData) {
            const msg = this.nodeEditor.buildShowNodeMessage(
                nodeId, nodeData, this.graphType
            );
            this.webview.postMessage(msg);
        } else {
            this.webview.postMessage(this.nodeEditor.buildClearMessage());
        }
    }

    /**
     * Handle edit requests from the node editor or document settings.
     * Applies changes to the YAML document via AST operations to preserve comments.
     * 
     * Special handling for nodeId '__meta__': paths are used directly (e.g., 'meta.title')
     * instead of being prefixed with 'nodes.<nodeId>'.
     */
    async onApplyEdit(
        editRequest: NodeEditRequest,
        document: vscode.TextDocument
    ): Promise<boolean> {
        const parsed = this.parser.parse(document.getText());
        const isMetaEdit = editRequest.nodeId === '__meta__';

        let updatedText = parsed.document.toString();
        for (const [field, value] of Object.entries(editRequest.changes)) {
            // For meta edits, use the field path directly (e.g., 'meta.title')
            // For node edits, prefix with 'nodes.<nodeId>.'
            const path = isMetaEdit ? field : `nodes.${editRequest.nodeId}.${field}`;
            const reparsed = this.parser.parse(updatedText);
            updatedText = this.parser.editValue(reparsed, path, value);
        }

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, updatedText);
        return vscode.workspace.applyEdit(edit);
    }

    /**
     * Handle request to add a new node.
     * Shows input dialog for node ID, then creates node with defaults.
     */
    async onRequestAddNode(document: vscode.TextDocument): Promise<void> {
        const nodeId = await vscode.window.showInputBox({
            prompt: 'Enter node ID',
            placeHolder: 'my-node',
            validateInput: (value) => {
                if (!value) return 'Node ID is required';
                if (!/^[a-z][a-z0-9-]*$/.test(value)) {
                    return 'Must start with lowercase letter and contain only lowercase letters, numbers, and hyphens';
                }
                // Check for duplicate
                const parsed = this.parser.parse(document.getText());
                const nodes = (parsed.data as any)?.nodes;
                if (nodes && value in nodes) {
                    return 'Node ID already exists';
                }
                return undefined;
            }
        });

        if (!nodeId) return;

        // Add node with default values
        const parsed = this.parser.parse(document.getText());
        const newNode = { label: nodeId };
        const updatedText = this.parser.addMapEntry(parsed, 'nodes', nodeId, newNode);

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, updatedText);
        await vscode.workspace.applyEdit(edit);

        // Select the new node
        this.onNodeSelected(nodeId, document);
    }

    /**
     * Handle request to duplicate an existing node.
     */
    async onRequestDuplicateNode(sourceNodeId: string, document: vscode.TextDocument): Promise<void> {
        const parsed = this.parser.parse(document.getText());
        const nodes = (parsed.data as any)?.nodes;
        const sourceNode = nodes?.[sourceNodeId];

        if (!sourceNode) {
            vscode.window.showErrorMessage(`Source node "${sourceNodeId}" not found`);
            return;
        }

        // Generate unique ID
        let newId = `${sourceNodeId}-copy`;
        let counter = 2;
        while (nodes && newId in nodes) {
            newId = `${sourceNodeId}-copy-${counter}`;
            counter++;
        }

        // Prompt for ID (pre-filled)
        const nodeId = await vscode.window.showInputBox({
            prompt: 'Enter ID for duplicated node',
            value: newId,
            validateInput: (value) => {
                if (!value) return 'Node ID is required';
                if (!/^[a-z][a-z0-9-]*$/.test(value)) {
                    return 'Must start with lowercase letter and contain only lowercase letters, numbers, and hyphens';
                }
                if (nodes && value in nodes) {
                    return 'Node ID already exists';
                }
                return undefined;
            }
        });

        if (!nodeId) return;

        // Copy node data (deep clone), update label
        const newNode = JSON.parse(JSON.stringify(sourceNode));
        if (newNode.label === sourceNodeId) {
            newNode.label = nodeId;
        }

        // Remove transitions (they reference the source node)
        delete newNode.transitions;

        const updatedText = this.parser.addMapEntry(parsed, 'nodes', nodeId, newNode);

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, updatedText);
        await vscode.workspace.applyEdit(edit);

        // Select the new node
        this.onNodeSelected(nodeId, document);
    }

    /**
     * Handle request to delete a node.
     */
    async onRequestDeleteNode(nodeId: string, document: vscode.TextDocument): Promise<void> {
        const parsed = this.parser.parse(document.getText());
        const updatedText = this.parser.deleteEntry(parsed, `nodes.${nodeId}`);

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, updatedText);
        await vscode.workspace.applyEdit(edit);

        this.currentNodeId = undefined;
    }

    /**
     * Handle request to rename a node.
     * Updates the node key and all references.
     */
    async onRequestRenameNode(oldId: string, newId: string, document: vscode.TextDocument): Promise<void> {
        const parsed = this.parser.parse(document.getText());
        const nodes = (parsed.data as any)?.nodes;
        const nodeData = nodes?.[oldId];

        if (!nodeData) {
            vscode.window.showErrorMessage(`Node "${oldId}" not found`);
            return;
        }

        // Add the node with the new ID
        let updatedText = this.parser.addMapEntry(parsed, 'nodes', newId, nodeData);

        // Delete the old node
        const reparsed = this.parser.parse(updatedText);
        updatedText = this.parser.deleteEntry(reparsed, `nodes.${oldId}`);

        // Update references in transitions (all nodes)
        const finalParsed = this.parser.parse(updatedText);
        const allNodes = (finalParsed.data as any)?.nodes;
        if (allNodes) {
            for (const [nid, ndata] of Object.entries(allNodes)) {
                const transitions = (ndata as any)?.transitions;
                if (Array.isArray(transitions)) {
                    for (let i = 0; i < transitions.length; i++) {
                        if (transitions[i].to === oldId) {
                            const refParsed = this.parser.parse(updatedText);
                            updatedText = this.parser.editValue(refParsed, `nodes.${nid}.transitions.${i}.to`, newId);
                        }
                    }
                }
            }
        }

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, updatedText);
        await vscode.workspace.applyEdit(edit);

        // Select the renamed node
        this.onNodeSelected(newId, document);
    }

    /**
     * Handle request to add a connection to a node.
     */
    async onRequestAddConnection(nodeId: string, document: vscode.TextDocument): Promise<void> {
        const parsed = this.parser.parse(document.getText());
        const nodes = (parsed.data as any)?.nodes;

        if (!nodes) return;

        // Get list of other node IDs for target selection
        const nodeIds = Object.keys(nodes).filter(id => id !== nodeId);
        if (nodeIds.length === 0) {
            vscode.window.showWarningMessage('No other nodes to connect to');
            return;
        }

        const targetId = await vscode.window.showQuickPick(nodeIds, {
            placeHolder: 'Select target node'
        });

        if (!targetId) return;

        // Add connection - first ensure transitions array exists
        const connection = { to: targetId };
        const nodeData = nodes[nodeId];
        let updatedText: string;

        if (!nodeData.transitions) {
            // Create transitions array with the new connection
            const reparsed = this.parser.parse(document.getText());
            updatedText = this.parser.editValue(reparsed, `nodes.${nodeId}.transitions`, [connection]);
        } else {
            // Append to existing transitions
            updatedText = this.parser.appendToSequence(parsed, `nodes.${nodeId}.transitions`, connection);
        }

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, updatedText);
        await vscode.workspace.applyEdit(edit);

        // Refresh node editor
        this.updateNodeEditor(nodeId, document);
    }

    /**
     * Handle request to delete a connection.
     */
    async onRequestDeleteConnection(nodeId: string, connectionIndex: number, document: vscode.TextDocument): Promise<void> {
        const parsed = this.parser.parse(document.getText());
        const updatedText = this.parser.deleteEntry(parsed, `nodes.${nodeId}.transitions.${connectionIndex}`);

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, updatedText);
        await vscode.workspace.applyEdit(edit);

        // Refresh node editor
        this.updateNodeEditor(nodeId, document);
    }
}
