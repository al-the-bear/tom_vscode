/**
 * Mermaid Flowchart Renderer
 *
 * Converts a TodoTreeNode tree into a mermaid flowchart TD diagram.
 * Uses subgraphs for directories, nodes for files and todos,
 * classDef for status colors, dotted edges for dependency links,
 * and click handlers for node interaction.
 */

import type { TodoTreeNode, TodoDependencyLink, NodeAction, RenderResult } from './types.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * Render a todo tree as a mermaid flowchart TD diagram.
 *
 * @param root - The root of the todo directory tree
 * @param links - Dependency and blocked_by links between todos
 * @returns The mermaid diagram string and a map of node IDs to actions
 */
export function renderFlowchart(
    root: TodoTreeNode,
    links: TodoDependencyLink[],
): RenderResult {
    const ctx = new RenderContext();

    // Header
    ctx.line('flowchart TD');

    // Class definitions for statuses
    ctx.line('    classDef notStarted fill:#444,stroke:#888,color:#ccc');
    ctx.line('    classDef inProgress fill:#264F78,stroke:#3794FF,color:#fff');
    ctx.line('    classDef completed fill:#1B3A1B,stroke:#4EC957,color:#ccc');
    ctx.line('    classDef cancelled fill:#3A1B1B,stroke:#CC3333,color:#ccc');
    ctx.line('    classDef blocked fill:#3A2E1B,stroke:#CCA633,color:#ccc');
    ctx.line('    classDef fileNode fill:#1E1E1E,stroke:#569CD6,stroke-width:2px,color:#9CDCFE');
    ctx.line('    classDef dirNode fill:#252526,stroke:#C586C0,stroke-width:2px,color:#C586C0');
    ctx.line('');

    // Render tree — skip single root wrapper for cleaner diagrams
    if (root.children.length === 1 && root.children[0].type === 'directory') {
        _renderNode(root.children[0], '    ', ctx);
    } else if (root.children.length > 0) {
        for (const child of root.children) {
            _renderNode(child, '    ', ctx);
        }
    } else {
        ctx.line('    empty["No todo files found"]');
    }

    // Dependency links (dotted arrows)
    ctx.line('');
    for (const link of links) {
        const fromNodeId = ctx.todoIdToNodeId.get(link.fromId);
        const toNodeId = ctx.todoIdToNodeId.get(link.toId);
        if (fromNodeId && toNodeId) {
            const label = link.type === 'blocked_by' ? 'blocked by' : 'depends on';
            ctx.line(`    ${fromNodeId} -.->|"${label}"| ${toNodeId}`);
        }
    }

    // Append class assignments and click handlers
    ctx.line('');
    for (const assignment of ctx.classAssignments) {
        ctx.line(assignment);
    }
    ctx.line('');
    for (const handler of ctx.clickHandlers) {
        ctx.line(handler);
    }

    return {
        mermaid: ctx.lines.join('\n'),
        nodeActions: ctx.nodeActions,
    };
}

// ============================================================================
// Internal Rendering
// ============================================================================

class RenderContext {
    lines: string[] = [];
    nodeActions: Record<string, NodeAction> = {};
    classAssignments: string[] = [];
    clickHandlers: string[] = [];
    todoIdToNodeId = new Map<string, string>();
    private _counter = 0;

    genId(): string {
        return `n${this._counter++}`;
    }

    line(text: string): void {
        this.lines.push(text);
    }
}

function _renderNode(node: TodoTreeNode, indent: string, ctx: RenderContext): void {
    if (node.type === 'directory') {
        _renderDirectory(node, indent, ctx);
    } else if (node.type === 'file') {
        _renderFile(node, indent, ctx);
    }
}

function _renderDirectory(node: TodoTreeNode, indent: string, ctx: RenderContext): void {
    if (node.children.length === 0) { return; }

    const dirId = ctx.genId();
    const label = _sanitize(node.name);
    ctx.line(`${indent}subgraph ${dirId}["📁 ${label}"]`);
    ctx.nodeActions[dirId] = { type: 'openDirectory', path: node.path };

    for (const child of node.children) {
        _renderNode(child, indent + '    ', ctx);
    }

    ctx.line(`${indent}end`);
    ctx.classAssignments.push(`    class ${dirId} dirNode`);
}

function _renderFile(node: TodoTreeNode, indent: string, ctx: RenderContext): void {
    const fileId = ctx.genId();
    const label = _sanitize(node.name);
    ctx.line(`${indent}${fileId}["📄 ${label}"]`);
    ctx.classAssignments.push(`    class ${fileId} fileNode`);
    ctx.clickHandlers.push(`    click ${fileId} call onNodeClick("${fileId}")`);
    ctx.nodeActions[fileId] = { type: 'openFile', path: node.path };

    if (node.todos) {
        for (const todo of node.todos) {
            const todoNodeId = ctx.genId();
            ctx.todoIdToNodeId.set(todo.id, todoNodeId);

            const icon = _statusIcon(todo.status);
            const id = _sanitize(todo.id);
            const title = _sanitize(todo.title || todo.id);
            const truncated = title.length > 40 ? title.substring(0, 37) + '...' : title;

            ctx.line(`${indent}${todoNodeId}["${icon} ${id}: ${truncated}"]`);
            ctx.line(`${indent}${fileId} --> ${todoNodeId}`);
            ctx.classAssignments.push(`    class ${todoNodeId} ${_statusClass(todo.status)}`);
            ctx.clickHandlers.push(`    click ${todoNodeId} call onNodeClick("${todoNodeId}")`);
            ctx.nodeActions[todoNodeId] = {
                type: 'selectTodo',
                todoId: todo.id,
                file: node.path,
            };
        }
    }
}

// ============================================================================
// Helpers
// ============================================================================

function _sanitize(text: string): string {
    return text
        .replace(/"/g, '#quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function _statusIcon(status: string): string {
    switch (status) {
        case 'in-progress': return '🔄';
        case 'completed': return '✅';
        case 'cancelled': return '⛔';
        case 'blocked': return '🚫';
        default: return '⬜';
    }
}

function _statusClass(status: string): string {
    switch (status) {
        case 'in-progress': return 'inProgress';
        case 'completed': return 'completed';
        case 'cancelled': return 'cancelled';
        case 'blocked': return 'blocked';
        default: return 'notStarted';
    }
}
