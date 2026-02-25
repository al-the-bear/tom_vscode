/**
 * Todo File Manager
 *
 * Read/write operations for *.todo.yaml files.
 * Uses the `yaml` package with CST-preserving Document API
 * to maintain comments and formatting on writes.
 *
 * Adapted from tom_vscode_extension/src/managers/questTodoManager.ts
 * with quest-specific logic removed for generic directory-based usage.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { isMap, isSeq } from 'yaml';
import type { YAMLMap, YAMLSeq } from 'yaml';
import type { TodoItem, TodoScope, TodoReference } from './types.js';

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Read all todo items from a single *.todo.yaml file.
 */
export function readTodoFile(filePath: string): TodoItem[] {
    if (!fs.existsSync(filePath)) { return []; }
    const raw = fs.readFileSync(filePath, 'utf8');
    const doc = YAML.parseDocument(raw);
    const root = doc.contents;
    if (!isMap(root)) { return []; }

    const todosNode = root.get('todos');
    if (!isSeq(todosNode)) { return []; }

    const items: TodoItem[] = [];
    for (const node of (todosNode as YAMLSeq).items) {
        if (!isMap(node)) { continue; }
        const item = _mapToTodoItem(node as YAMLMap);
        item._sourceFile = path.basename(filePath);
        items.push(item);
    }
    return items;
}

/**
 * Find a specific todo by ID in a file.
 */
export function findTodoByIdInFile(filePath: string, todoId: string): TodoItem | undefined {
    const items = readTodoFile(filePath);
    return items.find(t => t.id === todoId);
}

/**
 * List all *.todo.yaml files under a directory (recursive).
 * Returns relative paths from dirPath.
 */
export function listTodoFiles(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) { return []; }
    const results: string[] = [];
    _scanDir(dirPath, dirPath, results);
    return results.sort();
}

/**
 * Read all todos from all *.todo.yaml files in a directory.
 */
export function readAllTodosInDirectory(dirPath: string): TodoItem[] {
    const files = listTodoFiles(dirPath);
    const items: TodoItem[] = [];
    for (const rel of files) {
        const full = path.join(dirPath, rel);
        const fileItems = readTodoFile(full);
        for (const item of fileItems) {
            item._sourceFile = rel;
            items.push(item);
        }
    }
    return items;
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Ensure a todo file exists, creating it with a minimal structure if needed.
 */
export function ensureTodoFile(filePath: string, meta?: { quest?: string; scope?: string }): void {
    if (fs.existsSync(filePath)) { return; }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

    const header: Record<string, any> = {};
    if (meta?.quest) { header.quest = meta.quest; }
    if (meta?.scope) { header.scope = meta.scope; }
    header.todos = [];

    const doc = new YAML.Document(header);
    fs.writeFileSync(filePath, doc.toString(), 'utf8');
}

/**
 * Create a new todo item in a file.
 * Returns the created item.
 */
export function createTodoInFile(
    filePath: string,
    todo: Partial<TodoItem>,
    meta?: { quest?: string; scope?: string },
): TodoItem {
    ensureTodoFile(filePath, meta);
    const raw = fs.readFileSync(filePath, 'utf8');
    const doc = YAML.parseDocument(raw);
    const root = doc.contents;
    if (!isMap(root)) { throw new Error('Invalid todo file structure'); }

    let todosNode: unknown = root.get('todos');
    if (!isSeq(todosNode)) {
        const emptySeq = doc.createNode([]);
        (root as any).set('todos', emptySeq);
        todosNode = emptySeq;
    }

    const now = new Date().toISOString().slice(0, 10);
    const id = todo.id || `todo-${Date.now()}`;
    const item: TodoItem = {
        id,
        title: todo.title || '',
        description: todo.description || '',
        status: todo.status || 'not-started',
        priority: todo.priority || 'medium',
        tags: todo.tags || [],
        notes: todo.notes || '',
        created: now,
        updated: now,
    };
    if (todo.scope) { item.scope = todo.scope; }
    if (todo.references?.length) { item.references = todo.references; }
    if (todo.dependencies?.length) { item.dependencies = todo.dependencies; }
    if (todo.blocked_by?.length) { item.blocked_by = todo.blocked_by; }

    const newNode = doc.createNode(item);
    (todosNode as YAMLSeq).add(newNode);
    fs.writeFileSync(filePath, doc.toString(), 'utf8');

    item._sourceFile = path.basename(filePath);
    return item;
}

/**
 * Update an existing todo item in-place (CST-preserving).
 * Returns the updated item, or undefined if not found.
 */
export function updateTodoInFile(
    filePath: string,
    todoId: string,
    updates: Partial<TodoItem>,
): TodoItem | undefined {
    if (!fs.existsSync(filePath)) { return undefined; }
    const raw = fs.readFileSync(filePath, 'utf8');
    const doc = YAML.parseDocument(raw);
    const root = doc.contents;
    if (!isMap(root)) { return undefined; }

    const todosNode = root.get('todos');
    if (!isSeq(todosNode)) { return undefined; }

    for (const node of (todosNode as YAMLSeq).items) {
        if (!isMap(node)) { continue; }
        const nodeMap = node as YAMLMap;
        if (String(nodeMap.get('id')) !== todoId) { continue; }

        const now = new Date().toISOString().slice(0, 10);
        for (const [key, value] of Object.entries(updates)) {
            if (key === 'id' || key === '_sourceFile') { continue; }
            if (value === undefined) { continue; }
            if (typeof value === 'object' && !Array.isArray(value)) {
                nodeMap.set(key, doc.createNode(value));
            } else if (Array.isArray(value)) {
                nodeMap.set(key, doc.createNode(value));
            } else {
                nodeMap.set(key, value);
            }
        }
        nodeMap.set('updated', now);
        fs.writeFileSync(filePath, doc.toString(), 'utf8');

        const result = _mapToTodoItem(nodeMap);
        result._sourceFile = path.basename(filePath);
        return result;
    }
    return undefined;
}

// ============================================================================
// Tag Collection
// ============================================================================

/**
 * Collect all unique tags from todos in a directory.
 */
export function collectAllTags(dirPath: string): string[] {
    const todos = readAllTodosInDirectory(dirPath);
    const tags = new Set<string>();
    for (const todo of todos) {
        if (todo.tags) {
            for (const tag of todo.tags) { tags.add(tag); }
        }
    }
    return [...tags].sort();
}

// ============================================================================
// Internal Helpers
// ============================================================================

function _scanDir(basePath: string, currentPath: string, results: string[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'build') {
            continue;
        }
        const full = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
            _scanDir(basePath, full, results);
        } else if (entry.name.endsWith('.todo.yaml')) {
            results.push(path.relative(basePath, full));
        }
    }
}

function _mapToTodoItem(node: YAMLMap): TodoItem {
    const item: TodoItem = {
        id: String(node.get('id') ?? ''),
        title: _getString(node, 'title'),
        description: _getString(node, 'description'),
        status: String(node.get('status') ?? 'not-started'),
        priority: _getString(node, 'priority'),
        tags: _getStringArray(node, 'tags'),
        notes: _getString(node, 'notes'),
        created: _getString(node, 'created'),
        updated: _getString(node, 'updated'),
    };

    // scope
    const scopeNode = node.get('scope');
    if (isMap(scopeNode)) {
        const scopeMap = scopeNode as YAMLMap;
        item.scope = {
            project: _getString(scopeMap, 'project'),
            module: _getString(scopeMap, 'module'),
            area: _getString(scopeMap, 'area'),
            files: _getStringArray(scopeMap, 'files'),
        };
    }

    // references
    const refsNode = node.get('references');
    if (isSeq(refsNode)) {
        item.references = [];
        for (const ref of (refsNode as YAMLSeq).items) {
            if (!isMap(ref)) { continue; }
            const refMap = ref as YAMLMap;
            item.references.push({
                type: _getString(refMap, 'type'),
                path: _getString(refMap, 'path'),
                url: _getString(refMap, 'url'),
                description: _getString(refMap, 'description'),
            });
        }
    }

    // dependencies / blocked_by
    item.dependencies = _getStringArray(node, 'dependencies');
    item.blocked_by = _getStringArray(node, 'blocked_by');

    // dates
    const datesNode = node.get('dates');
    if (isMap(datesNode)) {
        item.dates = {};
        const datesMap = datesNode as YAMLMap;
        for (const pair of datesMap.items) {
            item.dates[String(pair.key)] = String(pair.value);
        }
    }

    return item;
}

function _getString(node: YAMLMap, key: string): string | undefined {
    const v = node.get(key);
    return v != null ? String(v) : undefined;
}

function _getStringArray(node: YAMLMap, key: string): string[] | undefined {
    const v = node.get(key);
    if (!isSeq(v)) { return undefined; }
    const arr: string[] = [];
    for (const item of (v as YAMLSeq).items) {
        arr.push(String(item));
    }
    return arr.length > 0 ? arr : undefined;
}
