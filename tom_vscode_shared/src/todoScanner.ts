/**
 * Todo Scanner
 *
 * Scans directories for *.todo.yaml files and builds a tree structure.
 * Supports root discovery by walking up the folder hierarchy looking
 * for a master.mindmap.yaml marker or topmost .git directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TodoItem, TodoTreeNode, TodoDependencyLink } from './types.js';
import { readTodoFile } from './todoFileManager.js';

// ============================================================================
// Root Discovery
// ============================================================================

/**
 * Find the scan root directory by walking up from startPath.
 * Priority:
 *   1. First directory containing `master.mindmap.yaml`
 *   2. Topmost `.git` directory found while walking up
 *   3. Falls back to startPath itself
 */
export function findScanRoot(startPath: string): string {
    let current = path.resolve(startPath);
    let topmostGit: string | undefined;

    while (true) {
        if (fs.existsSync(path.join(current, 'master.mindmap.yaml'))) {
            return current;
        }
        if (fs.existsSync(path.join(current, '.git'))) {
            topmostGit = current;
        }
        const parent = path.dirname(current);
        if (parent === current) { break; }
        current = parent;
    }

    return topmostGit || startPath;
}

// ============================================================================
// File Scanning
// ============================================================================

/**
 * Recursively scan for *.todo.yaml files under rootPath.
 * Returns relative paths sorted alphabetically.
 */
export function scanTodoFiles(rootPath: string): string[] {
    const results: string[] = [];
    _scanRecursive(rootPath, rootPath, results);
    return results.sort();
}

function _scanRecursive(basePath: string, currentPath: string, results: string[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        // Skip hidden dirs, build outputs, and dependency folders
        if (entry.name.startsWith('.') ||
            entry.name === 'node_modules' ||
            entry.name === 'out' ||
            entry.name === 'build' ||
            entry.name === 'ztmp') {
            continue;
        }
        const full = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
            _scanRecursive(basePath, full, results);
        } else if (entry.name.endsWith('.todo.yaml')) {
            results.push(path.relative(basePath, full));
        }
    }
}

// ============================================================================
// Tree Building
// ============================================================================

/**
 * Build a tree structure from scanned file paths.
 * Each file node includes its parsed todo items.
 */
export function buildTodoTree(rootPath: string, relativeFiles: string[]): TodoTreeNode {
    const root: TodoTreeNode = {
        name: path.basename(rootPath),
        path: rootPath,
        type: 'directory',
        children: [],
    };

    for (const rel of relativeFiles) {
        const parts = rel.split(/[/\\]/);
        let current = root;

        // Create intermediate directory nodes
        for (let i = 0; i < parts.length - 1; i++) {
            let child = current.children.find(c => c.name === parts[i] && c.type === 'directory');
            if (!child) {
                child = {
                    name: parts[i],
                    path: path.join(rootPath, ...parts.slice(0, i + 1)),
                    type: 'directory',
                    children: [],
                };
                current.children.push(child);
            }
            current = child;
        }

        // Create file node with parsed todos
        const fileName = parts[parts.length - 1];
        const fullPath = path.join(rootPath, rel);
        const todos = readTodoFile(fullPath).map(t => ({ ...t, _sourceFile: rel }));

        current.children.push({
            name: fileName,
            path: fullPath,
            type: 'file',
            children: [],
            todos,
        });
    }

    _sortTree(root);
    return root;
}

function _sortTree(node: TodoTreeNode): void {
    node.children.sort((a, b) => {
        if (a.type !== b.type) { return a.type === 'directory' ? -1 : 1; }
        return a.name.localeCompare(b.name);
    });
    for (const child of node.children) {
        _sortTree(child);
    }
}

// ============================================================================
// Dependency Extraction
// ============================================================================

/**
 * Extract all dependency and blocked_by links from todos in the tree.
 */
export function extractDependencyLinks(root: TodoTreeNode): TodoDependencyLink[] {
    const links: TodoDependencyLink[] = [];
    _collectLinks(root, links);
    return links;
}

function _collectLinks(node: TodoTreeNode, links: TodoDependencyLink[]): void {
    if (node.todos) {
        for (const todo of node.todos) {
            if (todo.dependencies) {
                for (const dep of todo.dependencies) {
                    links.push({
                        fromId: todo.id,
                        toId: dep,
                        type: 'depends_on',
                        fromFile: todo._sourceFile,
                    });
                }
            }
            if (todo.blocked_by) {
                for (const blocker of todo.blocked_by) {
                    links.push({
                        fromId: todo.id,
                        toId: blocker,
                        type: 'blocked_by',
                        fromFile: todo._sourceFile,
                    });
                }
            }
        }
    }
    for (const child of node.children) {
        _collectLinks(child, links);
    }
}

/**
 * Collect all todo IDs in the tree (for validating dependency targets).
 */
export function collectAllTodoIds(root: TodoTreeNode): Set<string> {
    const ids = new Set<string>();
    _collectIds(root, ids);
    return ids;
}

function _collectIds(node: TodoTreeNode, ids: Set<string>): void {
    if (node.todos) {
        for (const todo of node.todos) {
            ids.add(todo.id);
        }
    }
    for (const child of node.children) {
        _collectIds(child, ids);
    }
}
