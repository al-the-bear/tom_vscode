/**
 * yaml-graph-vscode public API.
 *
 * Re-exports all components needed by the VS Code extension
 * to integrate the YAML Graph Editor.
 */

// Main provider
export { YamlGraphEditorProvider } from './yaml-graph-editor-provider.js';

// VS Code-specific callbacks
export { VsCodeCallbacks } from './vscode-callbacks.js';

// Webview management
export { WebviewManager } from './webview-manager.js';

// Selection coordination
export { SelectionCoordinator } from './selection-coordinator.js';

// Tree panel data
export { TreeDataBuilder, type TreeDataBuilderOptions } from './tree-data-builder.js';
export { SourceSyncManager } from './source-sync-manager.js';

// Node editor
export { NodeEditorController } from './node-editor-controller.js';

// Schema resolution
export { SchemaResolver, type JsonSchemaNode } from './schema-resolver.js';

// Types
export type {
    TreeNode,
    FieldSchema,
    ScalarFieldSchema,
    EnumFieldSchema,
    ArrayFieldSchema,
    ObjectFieldSchema,
    WebviewMessage,
    ExtensionMessage,
    WebviewManagerOptions,
    SelectionEvent,
    NodeEditRequest,
    GraphTypeResolution,
} from './types.js';
