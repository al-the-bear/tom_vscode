/**
 * tom-vscode-shared
 *
 * Shared components for TOM VS Code extensions.
 * Provides todo file management, directory scanning,
 * and mermaid flowchart rendering.
 */

export type {
    TodoItem,
    TodoScope,
    TodoReference,
    TodoFile,
    TodoTreeNode,
    TodoDependencyLink,
    NodeAction,
    RenderResult,
} from './types.js';

export {
    readTodoFile,
    findTodoByIdInFile,
    listTodoFiles,
    readAllTodosInDirectory,
    ensureTodoFile,
    createTodoInFile,
    updateTodoInFile,
    collectAllTags,
} from './todoFileManager.js';

export {
    findScanRoot,
    scanTodoFiles,
    buildTodoTree,
    extractDependencyLinks,
    collectAllTodoIds,
} from './todoScanner.js';

export {
    renderFlowchart,
} from './mermaidFlowchartRenderer.js';
