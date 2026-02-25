/**
 * Types for yaml-graph-vscode — VS Code integration layer.
 *
 * Covers PostMessage protocol, tree data structures, and
 * schema-driven node editor field definitions.
 */

import type { ValidationError, SourceRange } from 'yaml-graph-core';

// ─── TreeNode ───────────────────────────────────────────────

/** A node in the tree panel displayed beside the Mermaid preview. */
export interface TreeNode {
    /** Unique identifier (matches YAML key, e.g. node ID). */
    id: string;
    /** Display label in the tree. */
    label: string;
    /** Node type from the YAML data (e.g. 'process', 'decision'). */
    type: string;
    /** Codicon icon name (without `$(…)` wrapper). */
    icon: string;
    /** Child nodes (for grouping or nested structures). */
    children?: TreeNode[];
    /** Whether the node starts expanded in the tree UI. */
    expanded?: boolean;
}

// ─── FieldSchema (recursive, schema-driven node editor) ─────

/** Union type for all field schemas the node editor can render. */
export type FieldSchema =
    | ScalarFieldSchema
    | EnumFieldSchema
    | ArrayFieldSchema
    | ObjectFieldSchema;

interface BaseFieldSchema {
    /** JSON pointer path relative to node root, e.g. "label", "metadata.priority". */
    path: string;
    /** Human-readable label for the form field. */
    label: string;
    /** Whether the field is required by the schema. */
    required: boolean;
    /** Optional description tooltip. */
    description?: string;
    /** Optional custom widget hint (e.g. "color-picker", "code", "url"). */
    xWidget?: string;
}

export interface ScalarFieldSchema extends BaseFieldSchema {
    fieldType: 'string' | 'number' | 'boolean';
    /** Render as <textarea> instead of <input> when true. */
    multiline?: boolean;
    minimum?: number;
    maximum?: number;
}

export interface EnumFieldSchema extends BaseFieldSchema {
    fieldType: 'enum';
    options: string[];
}

export interface ArrayFieldSchema extends BaseFieldSchema {
    fieldType: 'array';
    /** Schema for each array item (recursive). */
    itemSchema: FieldSchema;
    minItems?: number;
    maxItems?: number;
}

export interface ObjectFieldSchema extends BaseFieldSchema {
    fieldType: 'object';
    /** Child field schemas (recursive). */
    properties: FieldSchema[];
    /** Whether to allow free-form additional properties. */
    allowAdditional?: boolean;
}

// ─── PostMessage: Webview → Extension Host ──────────────────

export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'nodeClicked'; nodeId: string }
    | { type: 'treeNodeSelected'; nodeId: string }
    | { type: 'applyEdit'; nodeId: string; edits: Array<{ path: string; value: unknown }> }
    | { type: 'addNode'; parentPath: string; nodeType: string; nodeId: string }
    | { type: 'deleteNode'; nodeId: string }
    | { type: 'addEdge'; from: string; to: string; label?: string }
    | { type: 'deleteEdge'; index: number }
    | { type: 'reorderArrayItem'; nodeId: string; path: string; fromIndex: number; toIndex: number }
    | { type: 'addArrayItem'; nodeId: string; path: string }
    | { type: 'deleteArrayItem'; nodeId: string; path: string; index: number }
    | { type: 'requestExportSvg' }
    | { type: 'changeDirection'; direction: 'TD' | 'LR' | 'BT' | 'RL' }
    // New popup editor messages
    | { type: 'requestAddNode' }
    | { type: 'requestDuplicateNode'; sourceNodeId: string }
    | { type: 'requestDeleteNode'; nodeId: string }
    | { type: 'requestRenameNode'; oldId: string; newId: string }
    | { type: 'requestAddConnection'; nodeId: string }
    | { type: 'requestEditConnection'; nodeId: string; connectionIndex: number }
    | { type: 'requestDeleteConnection'; nodeId: string; connectionIndex: number };

// ─── PostMessage: Extension Host → Webview ──────────────────

export type ExtensionMessage =
    | { type: 'updateAll'; yamlText: string; mermaidSource: string; treeData: TreeNode[]; errors: ValidationError[] }
    | { type: 'selectNode'; nodeId: string }
    | { type: 'highlightMermaidNode'; nodeId: string }
    | { type: 'showNode'; nodeId: string; nodeData: unknown; schema: FieldSchema[] }
    | { type: 'showErrors'; errors: ValidationError[] }
    | { type: 'clearNodeEditor' };

// ─── WebviewManager options ─────────────────────────────────

export interface WebviewManagerOptions {
    /** Extension URI for resolving webview resources. */
    extensionUri: { fsPath: string };
    /** Optional base CSS to inject into the webview. */
    baseCss?: string;
    /** Optional per-graph-type CSS from the graph type configuration. */
    graphTypeCss?: string;
}

// ─── Selection event ────────────────────────────────────────

export interface SelectionEvent {
    /** Source of the selection change. */
    source: 'tree' | 'mermaid' | 'yaml' | 'nodeEditor';
    /** The selected node ID, or undefined for deselection. */
    nodeId: string | undefined;
}

// ─── Node edit request ──────────────────────────────────────

export interface NodeEditRequest {
    nodeId: string;
    changes: Record<string, unknown>;
}

// ─── Graph type resolution result ───────────────────────────

export interface GraphTypeResolution {
    /** Whether a graph type was found. */
    found: boolean;
    /** Error message if not found. */
    error?: string;
    /** The requested version from meta.graph-version. */
    requestedVersion?: number;
}
