/**
 * QuestTodoManager — reads and writes quest YAML todo files using the
 * `yaml` package's document API to preserve formatting, comments, and
 * anchors exactly as specified in chat_enhancements.md §1.3.
 *
 * File structure:
 *   _ai/quests/{questId}/
 *   ├── todos.{questId}.todo.yaml          # main quest todo file
 *   └── {YYYYMMDD}_{HHMM}_{winId}.todo.yaml  # session-scoped
 *
 * The existing JSON-schema (`todo.schema.json`) defines the shape of
 * each todo item.  This manager does NOT change the schema — it reads
 * and writes YAML that conforms to it.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Document, parseDocument, YAMLMap, YAMLSeq, Scalar, isMap, isSeq } from 'yaml';
import { WsPaths } from '../utils/workspacePaths';
import { scanWorkspaceProjectsByDetectors } from '../utils/projectDetector';
import { forceBlockStyle } from '../utils/todoArchive';
import { ALL_TODO_FILES, matchesTodoFileScope, type TodoFileScope } from '../utils/todoArchiveNames';
import { normaliseTodoDecisions, type TodoDecision } from '../utils/todoDecisions';

export { normaliseTodoDecisions, isDecisionResolved, hasUnresolvedDecisions, type TodoDecision } from '../utils/todoDecisions';

// Archive/delete move operations (TRA01) — implemented as pure fs+yaml
// utilities so they are unit-testable; surfaced here as manager API.
export {
    archiveTodos,
    deleteTodos,
    archiveAllCompleted,
    deleteAllCancelled,
    type TodoMoveResult,
    type TodoMoveSkip,
    type TodoMoveOptions,
} from '../utils/todoArchive';
export {
    ALL_TODO_FILES,
    archivedTodoFileName,
    deletedTodoFileName,
    isArchivedOrDeletedTodoFile,
    isArchivedTodoFile,
    isDeletedTodoFile,
    matchesTodoFileScope,
    type TodoFileScope,
} from '../utils/todoArchiveNames';

// ============================================================================
// Types (mirrors todo.schema.json)
// ============================================================================

export interface QuestTodoScope {
    project?: string;
    projects?: string[];
    module?: string;
    area?: string;
    files?: string[];
}

export interface QuestTodoReference {
    type?: string;
    path?: string;
    url?: string;
    description?: string;
    lines?: string;
}

export type QuestTodoStatus =
    | 'not-started'
    | 'in-progress'
    | 'blocked'
    | 'decision-needed'
    | 'completed'
    | 'cancelled';

export interface QuestTodoItem {
    id: string;
    title?: string;
    description: string;
    status: QuestTodoStatus;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    tags?: string[];
    scope?: QuestTodoScope;
    references?: QuestTodoReference[];
    dependencies?: string[];
    blocked_by?: string[];
    /** Decisions the user has to make before this todo can be started. */
    decisions?: TodoDecision[];
    notes?: string;
    created?: string;
    updated?: string;
    completed_date?: string;
    completed_by?: string;
    /** Runtime: which file this item was loaded from (not persisted). */
    _sourceFile?: string;
}

export interface QuestTodoFile {
    quest?: string;
    scope?: QuestTodoScope;
    references?: QuestTodoReference[];
    created?: string;
    updated?: string;
    author?: string;
    todos: QuestTodoItem[];
}

// ============================================================================
// Helpers
// ============================================================================

function getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function questFolder(questId: string): string {
    return WsPaths.ai('quests', questId) || path.join(getWorkspaceRoot(), '_ai', 'quests', questId);
}

/**
 * Return the todo YAML files of a quest, scoped by `scope` (TRA13).
 *
 * By default this lists the LIVE todo files only — the quest and session
 * files. The `-archived` / `-deleted` terminal siblings are retired and
 * are excluded unless the caller asks for them; see `TodoFileScope`.
 */
export function listTodoFiles(questId: string, scope?: TodoFileScope): string[] {
    const folder = questFolder(questId);
    if (!fs.existsSync(folder)) { return []; }
    return fs.readdirSync(folder).filter(f =>
        f.endsWith('.todo.yaml') && matchesTodoFileScope(f, scope),
    ).sort();
}

/** Persistent todo file path. */
export function persistentTodoPath(questId: string): string {
    return path.join(questFolder(questId), `todos.${questId}.todo.yaml`);
}

// ============================================================================
// YAML document helpers
// ============================================================================

/** Parse a YAML file into a Document (preserving CST). */
function loadDocument(filePath: string): Document {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseDocument(raw);
}

/** Write a Document back, preserving formatting. */
function saveDocument(filePath: string, doc: Document): void {
    fs.writeFileSync(filePath, doc.toString(), 'utf8');
}

/**
 * Build the YAML schema comment for a todo file.
 * The relative schema path depends on where the file is located.
 */
function schemaComment(filePath: string): string {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) { return ''; }
    const schemaAbs = path.join(wsRoot, '_ai', 'schemas', 'yaml', 'todo.schema.json');
    const rel = path.relative(path.dirname(filePath), schemaAbs);
    return `# yaml-language-server: $schema=${rel}\n`;
}

/**
 * Write a Document with the schema comment prepended.
 * If the document already has the schema comment, it won't be duplicated.
 */
function saveDocumentWithSchema(filePath: string, doc: Document): void {
    let content = doc.toString();
    if (!content.startsWith('# yaml-language-server:')) {
        content = schemaComment(filePath) + content;
    }
    fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Write the `decisions` list onto a todo node, or remove the key when there is
 * nothing left to decide. Normalised on the way in so a hand-edited or
 * tool-supplied list cannot persist unlabelled rows.
 */
function setDecisions(doc: Document, item: YAMLMap, decisions: TodoDecision[] | undefined): void {
    const normalised = normaliseTodoDecisions(decisions);
    if (!normalised) {
        item.delete('decisions');
        return;
    }
    const node = doc.createNode(normalised);
    forceBlockStyle(node);
    item.set('decisions', node);
}

/** Convert a YAML map node to a plain QuestTodoItem. */
function nodeToTodo(node: YAMLMap, sourceFile?: string): QuestTodoItem {
    const get = (key: string): unknown => node.get(key);
    const getStr = (key: string): string | undefined => {
        const v = get(key);
        return v === undefined || v === null ? undefined : String(v);
    };
    const getArr = (key: string): string[] | undefined => {
        const seq = node.get(key, true);
        if (!isSeq(seq)) { return undefined; }
        return seq.items.map((i: unknown) =>
            i instanceof Scalar ? String(i.value) : String(i),
        );
    };

    const item: QuestTodoItem = {
        id: getStr('id') ?? '',
        description: getStr('description') ?? '',
        status: (getStr('status') as QuestTodoItem['status']) ?? 'not-started',
    };
    const title = getStr('title');
    if (title) { item.title = title; }
    const priority = getStr('priority');
    if (priority) { item.priority = priority as QuestTodoItem['priority']; }
    const tags = getArr('tags');
    if (tags) { item.tags = tags; }
    const deps = getArr('dependencies');
    if (deps) { item.dependencies = deps; }
    const blockedBy = getArr('blocked_by');
    if (blockedBy) { item.blocked_by = blockedBy; }
    const notes = getStr('notes');
    if (notes) { item.notes = notes; }
    const created = getStr('created');
    if (created) { item.created = created; }
    const updated = getStr('updated');
    if (updated) { item.updated = updated; }
    const completedDate = getStr('completed_date');
    if (completedDate) { item.completed_date = completedDate; }
    const completedBy = getStr('completed_by');
    if (completedBy) { item.completed_by = completedBy; }

    // scope
    const scopeNode = node.get('scope', true);
    if (isMap(scopeNode)) {
        item.scope = {
            project: scopeNode.get('project') as string | undefined,
            module: scopeNode.get('module') as string | undefined,
            area: scopeNode.get('area') as string | undefined,
        };
        const projects = scopeNode.get('projects', true);
        if (isSeq(projects)) {
            item.scope.projects = projects.items.map((i: unknown) =>
                i instanceof Scalar ? String(i.value) : String(i));
        }
        const files = scopeNode.get('files', true);
        if (isSeq(files)) {
            item.scope.files = files.items.map((i: unknown) =>
                i instanceof Scalar ? String(i.value) : String(i));
        }
    }

    // references
    const refsNode = node.get('references', true);
    if (isSeq(refsNode)) {
        item.references = refsNode.items.filter(isMap).map((m: YAMLMap) => ({
            type: m.get('type') as string | undefined,
            path: m.get('path') as string | undefined,
            url: m.get('url') as string | undefined,
            description: m.get('description') as string | undefined,
            lines: m.get('lines') as string | undefined,
        }));
    }

    // decisions — normalised so every reader gets a labelled list or nothing.
    const decisionsNode = node.get('decisions', true);
    if (isSeq(decisionsNode)) {
        item.decisions = normaliseTodoDecisions(decisionsNode.toJSON());
    }

    if (sourceFile) { item._sourceFile = sourceFile; }
    return item;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Read all todos from a single file.
 */
export function readTodoFile(filePath: string): QuestTodoItem[] {
    if (!fs.existsSync(filePath)) { return []; }
    const doc = loadDocument(filePath);
    const todosNode = doc.get('todos', true);
    if (!isSeq(todosNode)) { return []; }
    const basename = path.basename(filePath);
    return todosNode.items.filter(isMap).map((n: YAMLMap) => nodeToTodo(n, basename));
}

/**
 * Ensure a todo YAML file exists with minimal structure.
 */
export function ensureTodoFile(
    filePath: string,
    header?: Record<string, unknown>,
): void {
    if (fs.existsSync(filePath)) { return; }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    // Build YAML content as a string so todos: [] renders as block-style "todos: []"
    const parts: string[] = [];
    if (header) {
        for (const [k, v] of Object.entries(header)) {
            if (typeof v === 'string') { parts.push(`${k}: ${v}`); }
            else if (typeof v === 'object' && v !== null) {
                const subDoc = new Document(v);
                parts.push(`${k}:\n` + subDoc.toString().split('\n').map(l => '  ' + l).join('\n').trimEnd());
            }
        }
    }
    parts.push(`created: "${new Date().toISOString().slice(0, 10)}"`);
    parts.push('todos: []');
    const doc = parseDocument(parts.join('\n') + '\n');
    saveDocumentWithSchema(filePath, doc);
}

/**
 * Find a single todo by ID in one specific file.
 */
export function findTodoByIdInFile(filePath: string, todoId: string): QuestTodoItem | undefined {
    return readTodoFile(filePath).find(t => t.id === todoId);
}

/**
 * Create a todo in an arbitrary todo YAML file.
 */
export function createTodoInFile(
    filePath: string,
    todo: Omit<QuestTodoItem, '_sourceFile'>,
    header?: Record<string, unknown>,
): QuestTodoItem {
    ensureTodoFile(filePath, header);
    const doc = loadDocument(filePath);

    let todosNode = doc.get('todos', true);
    if (!isSeq(todosNode)) {
        doc.set('todos', doc.createNode([]));
        todosNode = doc.get('todos', true) as YAMLSeq;
    }

    const plain: Record<string, unknown> = {
        id: todo.id,
        description: todo.description,
        status: todo.status,
    };
    if (todo.title) { plain.title = todo.title; }
    if (todo.priority) { plain.priority = todo.priority; }
    if (todo.tags && todo.tags.length) { plain.tags = todo.tags; }
    if (todo.notes) { plain.notes = todo.notes; }
    if (todo.dependencies && todo.dependencies.length) { plain.dependencies = todo.dependencies; }
    if (todo.blocked_by && todo.blocked_by.length) { plain.blocked_by = todo.blocked_by; }
    const decisions = normaliseTodoDecisions(todo.decisions);
    if (decisions) { plain.decisions = decisions; }
    if (todo.scope) { plain.scope = todo.scope; }
    if (todo.references && todo.references.length) { plain.references = todo.references; }
    if (todo.completed_date) { plain.completed_date = todo.completed_date; }
    if (todo.completed_by) { plain.completed_by = todo.completed_by; }
    plain.created = todo.created || new Date().toISOString().slice(0, 10);

    const newNode = doc.createNode(plain);
    forceBlockStyle(newNode);
    (todosNode as YAMLSeq).add(newNode);
    // Ensure the todos sequence itself is block-style
    forceBlockStyle(todosNode);
    doc.set('updated', new Date().toISOString().slice(0, 10));
    saveDocument(filePath, doc);

    return {
        ...todo,
        created: plain.created as string,
        _sourceFile: path.basename(filePath),
    };
}

/**
 * Update a todo in an arbitrary todo YAML file.
 */
export function updateTodoInFile(
    filePath: string,
    todoId: string,
    updates: Partial<Omit<QuestTodoItem, 'id' | '_sourceFile'>>,
): QuestTodoItem | undefined {
    if (!fs.existsSync(filePath)) { return undefined; }
    const doc = loadDocument(filePath);
    const todosNode = doc.get('todos', true);
    if (!isSeq(todosNode)) { return undefined; }

    for (const item of todosNode.items) {
        if (!isMap(item)) { continue; }
        if (String(item.get('id')) !== todoId) { continue; }

        if (updates.title !== undefined) { item.set('title', updates.title || undefined); }
        if (updates.description !== undefined) { item.set('description', updates.description); }
        if (updates.status !== undefined) { item.set('status', updates.status); }
        if (updates.priority !== undefined) { item.set('priority', updates.priority || undefined); }
        if (updates.notes !== undefined) { item.set('notes', updates.notes || undefined); }
        if (updates.tags !== undefined) { item.set('tags', updates.tags?.length ? doc.createNode(updates.tags) : undefined); }
        if (updates.dependencies !== undefined) { item.set('dependencies', updates.dependencies?.length ? doc.createNode(updates.dependencies) : undefined); }
        if (updates.blocked_by !== undefined) { item.set('blocked_by', updates.blocked_by?.length ? doc.createNode(updates.blocked_by) : undefined); }
        if (updates.decisions !== undefined) { setDecisions(doc, item, updates.decisions); }
        if (updates.completed_date !== undefined) { item.set('completed_date', updates.completed_date || undefined); }
        if (updates.completed_by !== undefined) { item.set('completed_by', updates.completed_by || undefined); }
        if (updates.scope !== undefined) {
            if (updates.scope && (updates.scope.project || updates.scope.projects?.length || updates.scope.module || updates.scope.area || updates.scope.files?.length)) {
                const scopeObj: Record<string, unknown> = {};
                if (updates.scope.project) scopeObj.project = updates.scope.project;
                if (updates.scope.projects?.length) scopeObj.projects = updates.scope.projects;
                if (updates.scope.module) scopeObj.module = updates.scope.module;
                if (updates.scope.area) scopeObj.area = updates.scope.area;
                if (updates.scope.files?.length) scopeObj.files = updates.scope.files;
                item.set('scope', doc.createNode(scopeObj));
            } else {
                item.delete('scope');
            }
        }
        if (updates.references !== undefined) {
            if (updates.references?.length) {
                item.set('references', doc.createNode(updates.references));
            } else {
                item.delete('references');
            }
        }

        item.set('updated', new Date().toISOString().slice(0, 10));
        doc.set('updated', new Date().toISOString().slice(0, 10));
        saveDocument(filePath, doc);
        return nodeToTodo(item as YAMLMap, path.basename(filePath));
    }

    return undefined;
}

/**
 * Read todos from the quest's live todo files (see `listTodoFiles`).
 *
 * Pass `ALL_TODO_FILES` to include archived/deleted todos — needed when
 * resolving a todo by id, not when counting or iterating "the todos".
 */
export function readAllTodos(questId: string, scope?: TodoFileScope): QuestTodoItem[] {
    const files = listTodoFiles(questId, scope);
    const folder = questFolder(questId);
    const all: QuestTodoItem[] = [];
    for (const f of files) {
        all.push(...readTodoFile(path.join(folder, f)));
    }
    return all;
}

/**
 * Read todos from ALL quest folders.
 * Each item's _sourceFile is prefixed with `questId/filename`.
 */
export function readAllQuestsTodos(): QuestTodoItem[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];
    const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
    if (!fs.existsSync(questsDir)) return [];
    const all: QuestTodoItem[] = [];
    const questDirs = fs.readdirSync(questsDir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name).sort();
    for (const qid of questDirs) {
        try {
            const todos = readAllTodos(qid);
            for (const t of todos) {
                t._sourceFile = qid + '/' + (t._sourceFile ?? '');
            }
            all.push(...todos);
        } catch { /* skip */ }
    }
    return all;
}

/**
 * List all quest directory names.
 */
export function listQuestIds(): string[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];
    const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
    if (!fs.existsSync(questsDir)) return [];
    return fs.readdirSync(questsDir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name).sort();
}

/**
 * Find all *.todo.yaml files across the entire workspace.
 * Returns items with _sourceFile set to workspace-relative path.
 */
export function readWorkspaceTodos(): QuestTodoItem[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];
    const all: QuestTodoItem[] = [];
    function walk(dir: string): void {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) { walk(fp); }
            else if (e.name.endsWith('.todo.yaml')) {
                try {
                    const items = readTodoFile(fp);
                    const rel = path.relative(wsRoot, fp);
                    for (const t of items) { t._sourceFile = rel; }
                    all.push(...items);
                } catch { /* skip */ }
            }
        }
    }
    walk(wsRoot);
    return all;
}

/**
 * List all *.todo.yaml files across the workspace as relative paths.
 */
export function listWorkspaceTodoFiles(): string[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];
    const files: string[] = [];
    function walk(dir: string): void {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) { walk(fp); }
            else if (e.name.endsWith('.todo.yaml')) {
                files.push(path.relative(wsRoot, fp));
            }
        }
    }
    walk(wsRoot);
    return files.sort();
}

/**
 * Find a single todo by ID across all files in a quest.
 * Returns the item with `_sourceFile` set, or undefined.
 */
export function findTodoById(questId: string, todoId: string): QuestTodoItem | undefined {
    // Resolving an id must still reach a todo that was archived or deleted —
    // otherwise the caller cannot tell "no such todo" from "retired todo".
    return readAllTodos(questId, ALL_TODO_FILES).find(t => t.id === todoId);
}

/**
 * Create a new todo item in a file (appends to the `todos` sequence).
 * If the file does not exist, creates it with a minimal structure.
 */
export function createTodo(
    questId: string,
    todo: Omit<QuestTodoItem, '_sourceFile'>,
    targetFile?: string,
): QuestTodoItem {
    const folder = questFolder(questId);
    if (!fs.existsSync(folder)) { fs.mkdirSync(folder, { recursive: true }); }

    let fileName = targetFile ?? `todos.${questId}.todo.yaml`;
    // Ensure the file name always ends with .todo.yaml
    if (!fileName.endsWith('.todo.yaml')) {
        if (fileName.endsWith('.yaml')) {
            fileName = fileName.replace(/\.yaml$/, '.todo.yaml');
        } else {
            fileName = fileName + '.todo.yaml';
        }
    }
    const filePath = path.join(folder, fileName);

    let doc: Document;
    let isNewFile = false;
    if (fs.existsSync(filePath)) {
        doc = loadDocument(filePath);
    } else {
        // Create minimal file
        isNewFile = true;
        doc = parseDocument(`quest: "${questId}"\ncreated: "${new Date().toISOString().slice(0, 10)}"\ntodos: []\n`);
    }

    let todosNode = doc.get('todos', true);
    if (!isSeq(todosNode)) {
        doc.set('todos', doc.createNode([]));
        todosNode = doc.get('todos', true) as YAMLSeq;
    }

    // Build the item as a plain object (yaml pkg will convert to YAML node)
    const plain: Record<string, unknown> = {
        id: todo.id,
        description: todo.description,
        status: todo.status,
    };
    if (todo.title) { plain.title = todo.title; }
    if (todo.priority) { plain.priority = todo.priority; }
    if (todo.tags && todo.tags.length) { plain.tags = todo.tags; }
    if (todo.notes) { plain.notes = todo.notes; }
    if (todo.dependencies && todo.dependencies.length) { plain.dependencies = todo.dependencies; }
    const decisions = normaliseTodoDecisions(todo.decisions);
    if (decisions) { plain.decisions = decisions; }
    plain.created = todo.created || new Date().toISOString().slice(0, 10);

    const newNode = doc.createNode(plain);
    forceBlockStyle(newNode);
    (todosNode as YAMLSeq).add(newNode);
    forceBlockStyle(todosNode);
    // Update file-level `updated` date
    doc.set('updated', new Date().toISOString().slice(0, 10));
    if (isNewFile) {
        saveDocumentWithSchema(filePath, doc);
    } else {
        saveDocument(filePath, doc);
    }

    return { ...todo, _sourceFile: fileName, created: plain.created as string };
}

/**
 * Update fields of an existing todo item in place (CST preservation).
 */
export function updateTodo(
    questId: string,
    todoId: string,
    updates: Partial<Omit<QuestTodoItem, 'id' | '_sourceFile'>>,
): QuestTodoItem | undefined {
    // Find which file contains this todo — including retired files, so an
    // archived todo can still be edited rather than silently not found.
    const folder = questFolder(questId);
    for (const fileName of listTodoFiles(questId, ALL_TODO_FILES)) {
        const filePath = path.join(folder, fileName);
        const doc = loadDocument(filePath);
        const todosNode = doc.get('todos', true);
        if (!isSeq(todosNode)) { continue; }

        for (const item of todosNode.items) {
            if (!isMap(item)) { continue; }
            if (String(item.get('id')) === todoId) {
                // Apply updates
                if (updates.title !== undefined) { item.set('title', updates.title || undefined); }
                if (updates.description !== undefined) { item.set('description', updates.description); }
                if (updates.status !== undefined) { item.set('status', updates.status); }
                if (updates.priority !== undefined) { item.set('priority', updates.priority || undefined); }
                if (updates.notes !== undefined) { item.set('notes', updates.notes || undefined); }
                if (updates.tags !== undefined) { item.set('tags', updates.tags?.length ? doc.createNode(updates.tags) : undefined); }
                if (updates.dependencies !== undefined) { item.set('dependencies', updates.dependencies?.length ? doc.createNode(updates.dependencies) : undefined); }
                if (updates.blocked_by !== undefined) { item.set('blocked_by', updates.blocked_by?.length ? doc.createNode(updates.blocked_by) : undefined); }
                if (updates.decisions !== undefined) { setDecisions(doc, item, updates.decisions); }
                if (updates.completed_date !== undefined) { item.set('completed_date', updates.completed_date || undefined); }
                if (updates.completed_by !== undefined) { item.set('completed_by', updates.completed_by || undefined); }
                if (updates.scope !== undefined) {
                    if (updates.scope && (updates.scope.project || updates.scope.projects?.length || updates.scope.module || updates.scope.area || updates.scope.files?.length)) {
                        const scopeObj: Record<string, unknown> = {};
                        if (updates.scope.project) scopeObj.project = updates.scope.project;
                        if (updates.scope.projects?.length) scopeObj.projects = updates.scope.projects;
                        if (updates.scope.module) scopeObj.module = updates.scope.module;
                        if (updates.scope.area) scopeObj.area = updates.scope.area;
                        if (updates.scope.files?.length) scopeObj.files = updates.scope.files;
                        item.set('scope', doc.createNode(scopeObj));
                    } else {
                        item.delete('scope');
                    }
                }
                if (updates.references !== undefined) {
                    if (updates.references?.length) {
                        item.set('references', doc.createNode(updates.references));
                    } else {
                        item.delete('references');
                    }
                }
                item.set('updated', new Date().toISOString().slice(0, 10));
                doc.set('updated', new Date().toISOString().slice(0, 10));
                saveDocument(filePath, doc);
                return nodeToTodo(item, fileName);
            }
        }
    }
    return undefined;
}

/**
 * Delete a todo item from its underlying YAML file.
 * If sourceFile is provided, it is used first to locate the concrete file.
 */
export function deleteTodo(
    questId: string,
    todoId: string,
    sourceFile?: string,
): boolean {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return false;

    const deleteFromFile = (filePath: string): boolean => {
        if (!fs.existsSync(filePath)) return false;
        const doc = loadDocument(filePath);
        const todosNode = doc.get('todos', true);
        if (!isSeq(todosNode)) return false;
        const idx = todosNode.items.findIndex((item: unknown) =>
            isMap(item) && String((item as YAMLMap).get('id')) === todoId,
        );
        if (idx < 0) return false;
        todosNode.items.splice(idx, 1);
        doc.set('updated', new Date().toISOString().slice(0, 10));
        saveDocument(filePath, doc);
        return true;
    };

    if (sourceFile && sourceFile.endsWith('.todo.yaml')) {
        const candidates = new Set<string>();
        if (path.isAbsolute(sourceFile)) {
            candidates.add(sourceFile);
        } else {
            if (sourceFile.startsWith('_ai/')) {
                candidates.add(path.join(wsRoot, sourceFile));
            }
            if (sourceFile.includes('/')) {
                const parts = sourceFile.split('/');
                if (parts.length > 1 && !sourceFile.startsWith('_ai/')) {
                    const qid = parts[0];
                    const fileName = parts.slice(1).join('/');
                    candidates.add(path.join(questFolder(qid), fileName));
                }
                candidates.add(path.join(wsRoot, sourceFile));
            }
            if (questId && !questId.startsWith('__') && !sourceFile.includes('/')) {
                candidates.add(path.join(questFolder(questId), sourceFile));
            }
        }
        for (const fp of candidates) {
            if (deleteFromFile(fp)) return true;
        }
    }

    if (questId && !questId.startsWith('__')) {
        const folder = questFolder(questId);
        // Retired files included: purging a todo from the archive is valid.
        for (const fileName of listTodoFiles(questId, ALL_TODO_FILES)) {
            if (deleteFromFile(path.join(folder, fileName))) return true;
        }
    }

    for (const rel of listWorkspaceTodoFiles()) {
        if (deleteFromFile(path.join(wsRoot, rel))) return true;
    }

    return false;
}

/**
 * Move a todo from one file to another.
 */
export function moveTodo(
    questId: string,
    todoId: string,
    targetFileName: string,
): QuestTodoItem | undefined {
    // Ensure the target file name always ends with .todo.yaml
    let normalizedTarget = targetFileName;
    if (!normalizedTarget.endsWith('.todo.yaml')) {
        if (normalizedTarget.endsWith('.yaml')) {
            normalizedTarget = normalizedTarget.replace(/\.yaml$/, '.todo.yaml');
        } else {
            normalizedTarget = normalizedTarget + '.todo.yaml';
        }
    }
    const folder = questFolder(questId);

    // 1. Find and remove from source — retired files included, so moving a
    //    todo OUT of the archive (un-archiving) works.
    for (const fileName of listTodoFiles(questId, ALL_TODO_FILES)) {
        const filePath = path.join(folder, fileName);
        const doc = loadDocument(filePath);
        const todosNode = doc.get('todos', true);
        if (!isSeq(todosNode)) { continue; }

        const idx = todosNode.items.findIndex((item: unknown) =>
            isMap(item) && String((item as YAMLMap).get('id')) === todoId,
        );
        if (idx === -1) { continue; }

        const todoNode = todosNode.items[idx] as YAMLMap;
        const todoPlain = nodeToTodo(todoNode);

        // Remove from source
        todosNode.items.splice(idx, 1);
        doc.set('updated', new Date().toISOString().slice(0, 10));
        saveDocument(filePath, doc);

        // 2. Add to target
        return createTodo(questId, todoPlain, normalizedTarget);
    }
    return undefined;
}

/**
 * Move a todo from a quest file to the workspace-level `workspace.todo.yaml`.
 * Removes the todo from its source quest file and appends it to
 * `<wsRoot>/workspace.todo.yaml`, creating the file if necessary.
 */
export function moveToWorkspaceTodo(
    questId: string,
    todoId: string,
): QuestTodoItem | undefined {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return undefined;
    const folder = questFolder(questId);

    // 1. Find and remove from source — retired files included, so moving a
    //    todo OUT of the archive (un-archiving) works.
    for (const fileName of listTodoFiles(questId, ALL_TODO_FILES)) {
        const filePath = path.join(folder, fileName);
        const doc = loadDocument(filePath);
        const todosNode = doc.get('todos', true);
        if (!isSeq(todosNode)) { continue; }

        const idx = todosNode.items.findIndex((item: unknown) =>
            isMap(item) && String((item as YAMLMap).get('id')) === todoId,
        );
        if (idx === -1) { continue; }

        const todoNode = todosNode.items[idx] as YAMLMap;
        const todoPlain = nodeToTodo(todoNode);

        // Remove from source
        todosNode.items.splice(idx, 1);
        doc.set('updated', new Date().toISOString().slice(0, 10));
        saveDocument(filePath, doc);

        // 2. Append to workspace.todo.yaml
        const wsFile = path.join(wsRoot, 'workspace.todo.yaml');
        let wsDo: Document;
        let wsIsNew = false;
        if (fs.existsSync(wsFile)) {
            wsDo = loadDocument(wsFile);
        } else {
            wsIsNew = true;
            wsDo = parseDocument(`scope:\n  area: workspace\ncreated: "${new Date().toISOString().slice(0, 10)}"\ntodos: []\n`);
        }

        let wsTodos = wsDo.get('todos', true);
        if (!isSeq(wsTodos)) {
            wsDo.set('todos', wsDo.createNode([]));
            wsTodos = wsDo.get('todos', true) as YAMLSeq;
        }

        // Build plain object
        const plain: Record<string, unknown> = { id: todoPlain.id };
        if (todoPlain.title) plain.title = todoPlain.title;
        plain.description = todoPlain.description;
        plain.status = todoPlain.status;
        if (todoPlain.priority) plain.priority = todoPlain.priority;
        if (todoPlain.tags?.length) plain.tags = todoPlain.tags;
        if (todoPlain.notes) plain.notes = todoPlain.notes;
        if (todoPlain.scope) plain.scope = todoPlain.scope;
        if (todoPlain.references?.length) plain.references = todoPlain.references;
        if (todoPlain.dependencies?.length) plain.dependencies = todoPlain.dependencies;
        if (todoPlain.blocked_by?.length) plain.blocked_by = todoPlain.blocked_by;
        if (todoPlain.created) plain.created = todoPlain.created;
        if (todoPlain.completed_date) plain.completed_date = todoPlain.completed_date;
        if (todoPlain.completed_by) plain.completed_by = todoPlain.completed_by;
        plain.updated = new Date().toISOString().slice(0, 10);
        // Tag the origin quest for traceability
        plain.notes = ((todoPlain.notes || '') + `\n[moved from quest: ${questId}]`).trim();

        const wsNewNode = wsDo.createNode(plain);
        forceBlockStyle(wsNewNode);
        (wsTodos as YAMLSeq).add(wsNewNode);
        forceBlockStyle(wsTodos);
        wsDo.set('updated', new Date().toISOString().slice(0, 10));
        if (wsIsNew) {
            saveDocumentWithSchema(wsFile, wsDo);
        } else {
            saveDocument(wsFile, wsDo);
        }

        return { ...todoPlain, _sourceFile: 'workspace.todo.yaml' };
    }
    return undefined;
}

/**
 * Collect all unique tags from all todo files across all quests.
 */
export function collectAllTags(questId?: string): string[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];
    const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
    if (!fs.existsSync(questsDir)) return [];
    const tagSet = new Set<string>();
    const questDirs = questId
        ? [questId]
        : fs.readdirSync(questsDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
    for (const qid of questDirs) {
        try {
            const todos = readAllTodos(qid);
            for (const t of todos) {
                if (t.tags) t.tags.forEach(tag => tagSet.add(tag));
            }
        } catch { /* skip */ }
    }
    return [...tagSet].sort();
}

// ============================================================================
// Project / module / area scanning for scope editor
// ============================================================================

export interface ScannedProject {
    name: string;
    relativePath: string;
    type: 'dart' | 'node' | 'other';
}

/**
 * Scan workspace for projects by looking for pubspec.yaml and package.json.
 * Returns project names with their relative paths.
 */
export function scanWorkspaceProjects(): ScannedProject[] {
    const detected = scanWorkspaceProjectsByDetectors(4);
    return detected
        .map((project) => {
            const types = project.attributes.types || [];
            let type: 'dart' | 'node' | 'other' = 'other';
            if (types.some((item) => item.includes('dart') || item.includes('flutter'))) {
                type = 'dart';
            } else if (types.some((item) => item.includes('node') || item.includes('vscode_extension'))) {
                type = 'node';
            }
            return {
                name: project.name,
                relativePath: project.relativePath,
                type,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Collect unique project/module/area values from all existing todos.
 */
export function collectScopeValues(): { projects: string[], modules: string[], areas: string[] } {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return { projects: [], modules: [], areas: [] };
    const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
    if (!fs.existsSync(questsDir)) return { projects: [], modules: [], areas: [] };
    const projects = new Set<string>();
    const modules = new Set<string>();
    const areas = new Set<string>();
    const questDirs = fs.readdirSync(questsDir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name);
    for (const qid of questDirs) {
        try {
            const todos = readAllTodos(qid);
            for (const t of todos) {
                if (t.scope?.project) projects.add(t.scope.project);
                if (t.scope?.projects?.length) {
                    for (const p of t.scope.projects) {
                        if (p) projects.add(p);
                    }
                }
                if (t.scope?.module) modules.add(t.scope.module);
                if (t.scope?.area) areas.add(t.scope.area);
            }
        } catch { /* skip */ }
    }
    return {
        projects: [...projects].sort(),
        modules: [...modules].sort(),
        areas: [...areas].sort(),
    };
}
