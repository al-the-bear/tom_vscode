/**
 * Shared types for TODO file management, scanning, and visualization.
 */

// ============================================================================
// Todo Item Types
// ============================================================================

/** A single todo item parsed from a *.todo.yaml file. */
export interface TodoItem {
    id: string;
    title?: string;
    description?: string;
    status: string;
    priority?: string;
    tags?: string[];
    scope?: TodoScope;
    references?: TodoReference[];
    dependencies?: string[];
    blocked_by?: string[];
    notes?: string;
    created?: string;
    updated?: string;
    dates?: Record<string, string>;
    /** Relative path of the source file (set during reading). */
    _sourceFile?: string;
}

/** Scope metadata for a todo item. */
export interface TodoScope {
    project?: string;
    module?: string;
    area?: string;
    files?: string[];
}

/** Reference link attached to a todo item. */
export interface TodoReference {
    type?: string;
    path?: string;
    url?: string;
    description?: string;
}

/** A todo file with its parsed items. */
export interface TodoFile {
    path: string;
    relativePath: string;
    items: TodoItem[];
}

// ============================================================================
// Scanner / Tree Types
// ============================================================================

/** A node in the todo directory tree. */
export interface TodoTreeNode {
    name: string;
    path: string;
    type: 'directory' | 'file';
    children: TodoTreeNode[];
    todos?: TodoItem[];
}

/** A dependency or blocked_by link between two todos. */
export interface TodoDependencyLink {
    fromId: string;
    toId: string;
    type: 'depends_on' | 'blocked_by';
    fromFile?: string;
    toFile?: string;
}

// ============================================================================
// Renderer Types
// ============================================================================

/** Action info attached to a mermaid diagram node. */
export interface NodeAction {
    type: 'openFile' | 'selectTodo' | 'openDirectory';
    path?: string;
    todoId?: string;
    file?: string;
}

/** Result of rendering a flowchart. */
export interface RenderResult {
    mermaid: string;
    nodeActions: Record<string, NodeAction>;
}
