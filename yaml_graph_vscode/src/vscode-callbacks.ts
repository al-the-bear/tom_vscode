/**
 * VsCodeCallbacks — VS Code-specific ConversionCallbacks implementation.
 *
 * Injects interactive behavior into the Mermaid output:
 * - Click callbacks on nodes for jump-to-tree navigation
 * - Pre-computation of workspace file data via prepare()
 */

import * as vscode from 'vscode';
import type { ConversionCallbacks, NodeData, EdgeData } from 'yaml-graph-core';

/**
 * VS Code-specific callback implementations.
 *
 * The prepare() method pre-computes async data (e.g., workspace file
 * existence) that the synchronous emit callbacks reference via `this`.
 */
export class VsCodeCallbacks implements ConversionCallbacks {
    private existingGraphFiles = new Set<string>();

    /** Mermaid types that support `click nodeId callback "arg"` syntax. */
    private static readonly CLICK_SUPPORTED_TYPES = new Set(['flowchart', 'graph']);

    /** Current mermaid type — set before each conversion. */
    private currentMermaidType = '';

    /**
     * Set the current Mermaid diagram type before conversion.
     * This controls whether click callbacks are emitted (only flowchart supports them).
     */
    setMermaidType(mermaidType: string): void {
        this.currentMermaidType = mermaidType;
    }

    /**
     * Pre-compute workspace data before conversion.
     * Called by ConversionEngine.convertWithPrepare().
     */
    async prepare(): Promise<void> {
        const files = await vscode.workspace.findFiles(
            '**/*.{flow,state,er}.yaml'
        );
        this.existingGraphFiles = new Set(
            files.map(f => vscode.workspace.asRelativePath(f))
        );
    }

    /**
     * Get the set of existing graph files found during prepare().
     * Useful for testing and for cross-file navigation features.
     */
    getExistingGraphFiles(): Set<string> {
        return this.existingGraphFiles;
    }

    /**
     * Inject click callback for jump-to-tree and jump-to-YAML navigation.
     * Only emitted for Mermaid types that support it (flowchart/graph).
     */
    onNodeEmit(
        nodeId: string,
        _nodeData: NodeData,
        _emittedLines: string[]
    ): string[] {
        if (VsCodeCallbacks.CLICK_SUPPORTED_TYPES.has(this.currentMermaidType)) {
            return [`click ${nodeId} callback "${nodeId}"`];
        }
        return [];
    }

    /**
     * No additional lines needed for edges.
     */
    onEdgeEmit(
        _edgeData: EdgeData,
        _emittedLines: string[]
    ): string[] {
        return [];
    }

    /**
     * No additional lines appended after all nodes/edges are emitted.
     */
    onComplete(
        _allNodeIds: string[],
        _output: string[]
    ): string[] {
        return [];
    }
}
