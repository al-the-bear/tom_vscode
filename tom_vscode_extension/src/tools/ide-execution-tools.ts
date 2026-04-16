/**
 * Wave C — IDE execution tools (approval gated).
 *
 * See `doc/llm_tools.md` §6.3 Wave C. All tools in this file mutate state —
 * workspace edits, processes, git writes, VS Code command execution, task /
 * debug launches — and carry `requiresApproval: true` unless explicitly
 * read-only (e.g. gitShow).
 *
 * Two small stateful registries live at module scope:
 *   - CODE_ACTION_REGISTRY: cache CodeAction objects returned by
 *     tomAi_getCodeActionsCached so tomAi_applyCodeAction can apply them by id.
 *   - PROCESS_REGISTRY: track long-running processes started by
 *     tomAi_runCommandStream so readCommandOutput / killCommand can address them.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { SharedToolDefinition } from './shared-tool-registry';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) { return filePath; }
    const root = wsRoot();
    return root ? path.join(root, filePath) : filePath;
}

function toRelative(uri: vscode.Uri): string {
    const root = wsRoot();
    if (!root) { return uri.fsPath; }
    const rel = path.relative(root, uri.fsPath);
    return rel.startsWith('..') ? uri.fsPath : rel;
}

// ---------------------------------------------------------------------------
// Code-action registry
// ---------------------------------------------------------------------------

interface CachedCodeAction {
    action: vscode.CodeAction;
    uri: vscode.Uri;
    expires: number;
}

const CODE_ACTION_REGISTRY = new Map<string, CachedCodeAction>();
const ACTION_TTL_MS = 5 * 60 * 1000;
let actionCounter = 0;

export function registerCodeAction(action: vscode.CodeAction, uri: vscode.Uri): string {
    const now = Date.now();
    for (const [k, v] of CODE_ACTION_REGISTRY.entries()) {
        if (v.expires < now) { CODE_ACTION_REGISTRY.delete(k); }
    }
    const id = `ca_${++actionCounter}_${now.toString(36)}`;
    CODE_ACTION_REGISTRY.set(id, { action, uri, expires: now + ACTION_TTL_MS });
    return id;
}

function lookupCodeAction(id: string): CachedCodeAction | undefined {
    const entry = CODE_ACTION_REGISTRY.get(id);
    if (!entry) { return undefined; }
    if (entry.expires < Date.now()) {
        CODE_ACTION_REGISTRY.delete(id);
        return undefined;
    }
    return entry;
}

// ---------------------------------------------------------------------------
// Process registry
// ---------------------------------------------------------------------------

interface TrackedProcess {
    id: string;
    command: string;
    cwd: string;
    child: ChildProcess;
    stdoutBuf: string[];
    stderrBuf: string[];
    stdoutCursor: number;
    stderrCursor: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    startedAt: number;
    endedAt: number | null;
    maxBufferLines: number;
}

const PROCESS_REGISTRY = new Map<string, TrackedProcess>();
let processCounter = 0;
const MAX_BUFFER_LINES_DEFAULT = 2000;

function appendBounded(buf: string[], chunk: string, max: number): void {
    const lines = chunk.split('\n');
    if (lines.length && buf.length) {
        buf[buf.length - 1] += lines.shift()!;
    }
    for (const l of lines) { buf.push(l); }
    const overflow = buf.length - max;
    if (overflow > 0) { buf.splice(0, overflow); }
}

function trackProcess(command: string, cwd: string, child: ChildProcess, maxBufferLines: number): TrackedProcess {
    const id = `proc_${++processCounter}_${Date.now().toString(36)}`;
    const proc: TrackedProcess = {
        id, command, cwd, child,
        stdoutBuf: [''],
        stderrBuf: [''],
        stdoutCursor: 0,
        stderrCursor: 0,
        exitCode: null,
        signal: null,
        startedAt: Date.now(),
        endedAt: null,
        maxBufferLines,
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => appendBounded(proc.stdoutBuf, d, maxBufferLines));
    child.stderr?.on('data', (d: string) => appendBounded(proc.stderrBuf, d, maxBufferLines));
    child.on('exit', (code, signal) => {
        proc.exitCode = code;
        proc.signal = signal;
        proc.endedAt = Date.now();
    });
    child.on('error', (err) => {
        appendBounded(proc.stderrBuf, `\n[spawn error] ${err.message}\n`, maxBufferLines);
        if (proc.endedAt === null) {
            proc.exitCode = -1;
            proc.endedAt = Date.now();
        }
    });
    PROCESS_REGISTRY.set(id, proc);
    return proc;
}

// ---------------------------------------------------------------------------
// tomAi_applyEdit
// ---------------------------------------------------------------------------

interface ApplyEditInputRange { startLine: number; startCharacter: number; endLine: number; endCharacter: number }

interface ApplyEditOp {
    op: 'replace' | 'insert' | 'delete' | 'createFile' | 'deleteFile' | 'renameFile';
    filePath?: string;
    fromPath?: string;
    toPath?: string;
    range?: ApplyEditInputRange;
    position?: { line: number; character: number };
    text?: string;
    overwrite?: boolean;
    ignoreIfExists?: boolean;
    ignoreIfNotExists?: boolean;
}

interface ApplyEditInput { operations: ApplyEditOp[] }

async function executeApplyEdit(input: ApplyEditInput): Promise<string> {
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
        return JSON.stringify({ error: 'operations must be a non-empty array' });
    }
    const edit = new vscode.WorkspaceEdit();

    for (const op of input.operations) {
        try {
            if (op.op === 'createFile') {
                if (!op.filePath) { return JSON.stringify({ error: 'createFile requires filePath' }); }
                edit.createFile(vscode.Uri.file(resolvePath(op.filePath)), {
                    overwrite: !!op.overwrite,
                    ignoreIfExists: op.ignoreIfExists ?? true,
                });
                continue;
            }
            if (op.op === 'deleteFile') {
                if (!op.filePath) { return JSON.stringify({ error: 'deleteFile requires filePath' }); }
                edit.deleteFile(vscode.Uri.file(resolvePath(op.filePath)), {
                    ignoreIfNotExists: op.ignoreIfNotExists ?? false,
                });
                continue;
            }
            if (op.op === 'renameFile') {
                if (!op.fromPath || !op.toPath) {
                    return JSON.stringify({ error: 'renameFile requires fromPath and toPath' });
                }
                edit.renameFile(
                    vscode.Uri.file(resolvePath(op.fromPath)),
                    vscode.Uri.file(resolvePath(op.toPath)),
                    { overwrite: !!op.overwrite, ignoreIfExists: op.ignoreIfExists ?? false },
                );
                continue;
            }
            if (!op.filePath) { return JSON.stringify({ error: `${op.op} requires filePath` }); }
            const uri = vscode.Uri.file(resolvePath(op.filePath));
            if (op.op === 'insert') {
                if (!op.position) { return JSON.stringify({ error: 'insert requires position' }); }
                edit.insert(uri, new vscode.Position(op.position.line, op.position.character), op.text ?? '');
                continue;
            }
            if (op.op === 'delete') {
                if (!op.range) { return JSON.stringify({ error: 'delete requires range' }); }
                edit.delete(uri, new vscode.Range(
                    new vscode.Position(op.range.startLine, op.range.startCharacter),
                    new vscode.Position(op.range.endLine, op.range.endCharacter),
                ));
                continue;
            }
            if (op.op === 'replace') {
                if (!op.range) { return JSON.stringify({ error: 'replace requires range' }); }
                edit.replace(uri, new vscode.Range(
                    new vscode.Position(op.range.startLine, op.range.startCharacter),
                    new vscode.Position(op.range.endLine, op.range.endCharacter),
                ), op.text ?? '');
                continue;
            }
            return JSON.stringify({ error: `Unknown op: ${op.op}` });
        } catch (err: any) {
            return JSON.stringify({ error: `Failed to prepare ${op.op}: ${err?.message ?? err}` });
        }
    }

    try {
        const applied = await vscode.workspace.applyEdit(edit);
        return JSON.stringify({ applied, operationCount: input.operations.length });
    } catch (err: any) {
        return JSON.stringify({ error: `applyEdit failed: ${err?.message ?? err}` });
    }
}

export const APPLY_EDIT_TOOL: SharedToolDefinition<ApplyEditInput> = {
    name: 'tomAi_applyEdit',
    displayName: 'Apply Workspace Edit',
    description:
        'Apply a transactional multi-file WorkspaceEdit (atomic undo). ' +
        'Operations: replace/insert/delete within a file; createFile/deleteFile/renameFile at the workspace level. ' +
        'Prefer this over multiple tomAi_editFile calls for refactors.',
    tags: ['files', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['operations'],
        properties: {
            operations: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['op'],
                    properties: {
                        op: { type: 'string', enum: ['replace', 'insert', 'delete', 'createFile', 'deleteFile', 'renameFile'] },
                        filePath: { type: 'string' },
                        fromPath: { type: 'string' },
                        toPath: { type: 'string' },
                        text: { type: 'string' },
                        range: {
                            type: 'object',
                            properties: {
                                startLine: { type: 'number' },
                                startCharacter: { type: 'number' },
                                endLine: { type: 'number' },
                                endCharacter: { type: 'number' },
                            },
                        },
                        position: {
                            type: 'object',
                            properties: {
                                line: { type: 'number' },
                                character: { type: 'number' },
                            },
                        },
                        overwrite: { type: 'boolean' },
                        ignoreIfExists: { type: 'boolean' },
                        ignoreIfNotExists: { type: 'boolean' },
                    },
                },
            },
        },
    },
    execute: executeApplyEdit,
};

// ---------------------------------------------------------------------------
// tomAi_getCodeActionsCached + tomAi_applyCodeAction
// ---------------------------------------------------------------------------

interface GetCodeActionsCachedInput {
    filePath: string;
    startLine: number;
    startCharacter: number;
    endLine?: number;
    endCharacter?: number;
    only?: string;
}

async function executeGetCodeActionsCached(input: GetCodeActionsCachedInput): Promise<string> {
    const abs = resolvePath(input.filePath);
    if (!fs.existsSync(abs)) { return JSON.stringify({ error: `File not found: ${abs}` }); }
    const uri = vscode.Uri.file(abs);
    try { await vscode.workspace.openTextDocument(uri); }
    catch (err: any) { return JSON.stringify({ error: `Could not open: ${err?.message ?? err}` }); }

    const endLine = input.endLine ?? input.startLine;
    const endChar = input.endCharacter ?? input.startCharacter;
    const range = new vscode.Range(
        new vscode.Position(Math.max(0, input.startLine), Math.max(0, input.startCharacter)),
        new vscode.Position(Math.max(0, endLine), Math.max(0, endChar)),
    );
    try {
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider', uri, range, input.only,
        );
        const items = (actions ?? []).map((a) => ({
            actionId: registerCodeAction(a, uri),
            title: a.title,
            kind: a.kind?.value,
            isPreferred: a.isPreferred,
            hasEdit: !!a.edit,
            hasCommand: !!a.command,
            commandId: a.command?.command,
            diagnosticsCount: a.diagnostics?.length ?? 0,
        }));
        return JSON.stringify({ count: items.length, actions: items }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Code actions failed: ${err?.message ?? err}` });
    }
}

export const GET_CODE_ACTIONS_CACHED_TOOL: SharedToolDefinition<GetCodeActionsCachedInput> = {
    name: 'tomAi_getCodeActionsCached',
    displayName: 'Get Code Actions (Cached)',
    description:
        'Like tomAi_getCodeActions but registers each action in a 5-minute cache and returns ' +
        'an actionId you can pass to tomAi_applyCodeAction. Use when you intend to apply an action.',
    tags: ['refactor', 'edit', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'startLine', 'startCharacter'],
        properties: {
            filePath: { type: 'string' },
            startLine: { type: 'number' },
            startCharacter: { type: 'number' },
            endLine: { type: 'number' },
            endCharacter: { type: 'number' },
            only: { type: 'string' },
        },
    },
    execute: executeGetCodeActionsCached,
};

interface ApplyCodeActionInput { actionId: string }

async function executeApplyCodeAction(input: ApplyCodeActionInput): Promise<string> {
    if (!input.actionId) { return JSON.stringify({ error: 'actionId is required' }); }
    const entry = lookupCodeAction(input.actionId);
    if (!entry) {
        return JSON.stringify({
            error: `Action not found or expired: ${input.actionId}. ` +
                'Re-run tomAi_getCodeActionsCached and use a fresh actionId.',
        });
    }
    const { action } = entry;
    const result: Record<string, unknown> = { actionId: input.actionId, title: action.title };
    try {
        if (action.edit) {
            const applied = await vscode.workspace.applyEdit(action.edit);
            result.editApplied = applied;
        }
        if (action.command) {
            const cmdResult = await vscode.commands.executeCommand(
                action.command.command, ...(action.command.arguments ?? []),
            );
            result.commandResult = cmdResult ?? null;
        }
        result.success = true;
        return JSON.stringify(result, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Apply code action failed: ${err?.message ?? err}` });
    }
}

export const APPLY_CODE_ACTION_TOOL: SharedToolDefinition<ApplyCodeActionInput> = {
    name: 'tomAi_applyCodeAction',
    displayName: 'Apply Code Action',
    description:
        'Apply a code action previously returned by tomAi_getCodeActionsCached. ' +
        'Executes the action\'s workspace edit and/or command. IDs expire after 5 minutes.',
    tags: ['refactor', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['actionId'],
        properties: {
            actionId: { type: 'string', description: 'The actionId returned from tomAi_getCodeActionsCached.' },
        },
    },
    execute: executeApplyCodeAction,
};

// ---------------------------------------------------------------------------
// tomAi_rename
// ---------------------------------------------------------------------------

interface RenameInput { filePath: string; line: number; character: number; newName: string }

async function executeRename(input: RenameInput): Promise<string> {
    if (!input.newName) { return JSON.stringify({ error: 'newName is required' }); }
    const abs = resolvePath(input.filePath);
    if (!fs.existsSync(abs)) { return JSON.stringify({ error: `File not found: ${abs}` }); }
    const uri = vscode.Uri.file(abs);
    try { await vscode.workspace.openTextDocument(uri); }
    catch (err: any) { return JSON.stringify({ error: `Could not open: ${err?.message ?? err}` }); }
    const pos = new vscode.Position(Math.max(0, input.line), Math.max(0, input.character));
    try {
        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
            'vscode.executeDocumentRenameProvider', uri, pos, input.newName,
        );
        if (!edit || typeof (edit as any).size !== 'number' || (edit as any).size === 0) {
            return JSON.stringify({ error: 'Rename provider returned no edits. Position may not be a renameable symbol.' });
        }
        const applied = await vscode.workspace.applyEdit(edit);
        const affected: string[] = [];
        for (const [uri] of (edit as any).entries() as Iterable<[vscode.Uri, unknown]>) {
            affected.push(toRelative(uri));
        }
        return JSON.stringify({ applied, newName: input.newName, affectedFiles: affected }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Rename failed: ${err?.message ?? err}` });
    }
}

export const RENAME_TOOL: SharedToolDefinition<RenameInput> = {
    name: 'tomAi_rename',
    displayName: 'Rename Symbol',
    description:
        'Workspace-wide rename of the symbol at a given file/line/character using the language server. ' +
        'Safer than text replacement because the LSP understands scope.',
    tags: ['refactor', 'symbols', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'line', 'character', 'newName'],
        properties: {
            filePath: { type: 'string' },
            line: { type: 'number' },
            character: { type: 'number' },
            newName: { type: 'string' },
        },
    },
    execute: executeRename,
};

// ---------------------------------------------------------------------------
// tomAi_vscode — meta-tool (wrapper over executeCommand)
// ---------------------------------------------------------------------------

const VSCODE_SAFE_COMMAND_PREFIXES: ReadonlyArray<string> = [
    'editor.action.',
    'workbench.action.focus',
    'workbench.action.navigate',
    'workbench.action.showCommands',
    'workbench.action.openSettings',
    'workbench.action.quickOpen',
    'workbench.action.toggle',
    'workbench.view.',
    'cursorMove',
    'revealLine',
    'cursorHome',
    'cursorEnd',
];

function isSafeVscodeCommand(cmd: string): boolean {
    return VSCODE_SAFE_COMMAND_PREFIXES.some((p) => cmd.startsWith(p));
}

interface VscodeMetaInput { command: string; args?: unknown[] }

async function executeVscodeMeta(input: VscodeMetaInput): Promise<string> {
    if (!input.command) { return JSON.stringify({ error: 'command is required' }); }
    try {
        const result = await vscode.commands.executeCommand(input.command, ...(input.args ?? []));
        return JSON.stringify({
            success: true,
            command: input.command,
            safeListed: isSafeVscodeCommand(input.command),
            result: result === undefined ? null : result,
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Command failed: ${err?.message ?? err}`, command: input.command });
    }
}

export const VSCODE_META_TOOL: SharedToolDefinition<VscodeMetaInput> = {
    name: 'tomAi_vscode',
    displayName: 'VS Code Meta Command',
    description:
        'Execute any VS Code command with typed args array. Complements tomAi_runVscodeCommand ' +
        '(string-only args) by passing arbitrary JSON-typed arguments. ' +
        'The description includes a safe-list prefix hint (editor.action.*, cursorMove, etc.); ' +
        'commands outside the hint should be reviewed before approval. ' +
        'Pair with tomAi_listCommands to discover IDs.',
    tags: ['vscode', 'meta', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['command'],
        properties: {
            command: { type: 'string', description: 'VS Code command ID (see tomAi_listCommands).' },
            args: { type: 'array', description: 'Optional JSON-typed arguments.' },
        },
    },
    execute: executeVscodeMeta,
};

// ---------------------------------------------------------------------------
// tomAi_runTask
// ---------------------------------------------------------------------------

interface RunTaskInput { name: string; waitForExit?: boolean; timeoutMs?: number }

async function executeRunTask(input: RunTaskInput): Promise<string> {
    if (!input.name) { return JSON.stringify({ error: 'name is required' }); }
    try {
        const tasks = await vscode.tasks.fetchTasks();
        const task = tasks.find((t) => t.name === input.name)
            || tasks.find((t) => t.name.toLowerCase() === input.name.toLowerCase());
        if (!task) {
            return JSON.stringify({
                error: `Task not found: "${input.name}"`,
                availableTasks: tasks.map((t) => t.name),
            });
        }
        const execution = await vscode.tasks.executeTask(task);
        const waitForExit = input.waitForExit !== false;
        if (!waitForExit) {
            return JSON.stringify({ started: true, task: task.name });
        }
        const timeout = Math.max(1000, input.timeoutMs ?? 5 * 60 * 1000);
        const result = await new Promise<{ exitCode: number | undefined; timedOut: boolean }>((resolve) => {
            const timer = setTimeout(() => {
                disposable.dispose();
                resolve({ exitCode: undefined, timedOut: true });
            }, timeout);
            const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
                if (e.execution === execution) {
                    clearTimeout(timer);
                    disposable.dispose();
                    resolve({ exitCode: e.exitCode, timedOut: false });
                }
            });
        });
        return JSON.stringify({
            task: task.name,
            exitCode: result.exitCode ?? null,
            timedOut: result.timedOut,
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Run task failed: ${err?.message ?? err}` });
    }
}

export const RUN_TASK_TOOL: SharedToolDefinition<RunTaskInput> = {
    name: 'tomAi_runTask',
    displayName: 'Run VS Code Task',
    description:
        'Execute a VS Code task defined in tasks.json by name. ' +
        'Returns the exit code when waitForExit=true (default).',
    tags: ['tasks', 'execution', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string', description: 'Task name (case-insensitive fallback).' },
            waitForExit: { type: 'boolean', description: 'Wait for task completion. Default true.' },
            timeoutMs: { type: 'number', description: 'Timeout in ms. Default 300000 (5 min).' },
        },
    },
    execute: executeRunTask,
};

// ---------------------------------------------------------------------------
// tomAi_runDebugConfig
// ---------------------------------------------------------------------------

interface RunDebugConfigInput {
    configName: string;
    folder?: string;
    waitForExit?: boolean;
    timeoutMs?: number;
}

async function executeRunDebugConfig(input: RunDebugConfigInput): Promise<string> {
    if (!input.configName) { return JSON.stringify({ error: 'configName is required' }); }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = input.folder
        ? folders.find((f) => f.name === input.folder || f.uri.fsPath === input.folder)
        : folders[0];

    try {
        const started = await vscode.debug.startDebugging(folder, input.configName);
        if (!started) {
            return JSON.stringify({ error: `Failed to start debug config: ${input.configName}` });
        }
        const waitForExit = input.waitForExit !== false;
        if (!waitForExit) {
            return JSON.stringify({ started: true, configName: input.configName });
        }
        const timeout = Math.max(1000, input.timeoutMs ?? 10 * 60 * 1000);
        const result = await new Promise<{ timedOut: boolean; sessionName?: string }>((resolve) => {
            const timer = setTimeout(() => {
                disposable.dispose();
                resolve({ timedOut: true });
            }, timeout);
            const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
                if (session.configuration.name === input.configName) {
                    clearTimeout(timer);
                    disposable.dispose();
                    resolve({ timedOut: false, sessionName: session.name });
                }
            });
        });
        return JSON.stringify({
            configName: input.configName,
            sessionName: result.sessionName ?? null,
            timedOut: result.timedOut,
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Debug start failed: ${err?.message ?? err}` });
    }
}

export const RUN_DEBUG_CONFIG_TOOL: SharedToolDefinition<RunDebugConfigInput> = {
    name: 'tomAi_runDebugConfig',
    displayName: 'Run Debug Configuration',
    description:
        'Launch a debug configuration from launch.json and optionally wait for session end.',
    tags: ['debug', 'execution', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['configName'],
        properties: {
            configName: { type: 'string', description: 'Debug configuration name.' },
            folder: { type: 'string', description: 'Workspace folder name. Default: first folder.' },
            waitForExit: { type: 'boolean', description: 'Wait for session termination. Default true.' },
            timeoutMs: { type: 'number', description: 'Timeout in ms. Default 600000 (10 min).' },
        },
    },
    execute: executeRunDebugConfig,
};

// ---------------------------------------------------------------------------
// tomAi_runCommandStream + tomAi_readCommandOutput + tomAi_killCommand
// ---------------------------------------------------------------------------

interface RunCommandStreamInput {
    command: string;
    cwd?: string;
    shell?: boolean;
    maxBufferLines?: number;
}

async function executeRunCommandStream(input: RunCommandStreamInput): Promise<string> {
    if (!input.command) { return JSON.stringify({ error: 'command is required' }); }
    const cwd = input.cwd ? resolvePath(input.cwd) : (wsRoot() ?? process.cwd());
    const useShell = input.shell !== false;
    const maxLines = Math.max(100, input.maxBufferLines ?? MAX_BUFFER_LINES_DEFAULT);

    try {
        const child = useShell
            ? spawn(input.command, { cwd, shell: true })
            : spawn(input.command.split(/\s+/)[0], input.command.split(/\s+/).slice(1), { cwd });
        const tracked = trackProcess(input.command, cwd, child, maxLines);
        // Small delay to capture immediate output or immediate exit
        await new Promise((r) => setTimeout(r, 50));
        return JSON.stringify({
            handle: tracked.id,
            pid: child.pid ?? null,
            running: tracked.endedAt === null,
            exitCode: tracked.exitCode,
            stdoutPreview: tracked.stdoutBuf.slice(-20).join('\n'),
            stderrPreview: tracked.stderrBuf.slice(-20).join('\n'),
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Spawn failed: ${err?.message ?? err}` });
    }
}

export const RUN_COMMAND_STREAM_TOOL: SharedToolDefinition<RunCommandStreamInput> = {
    name: 'tomAi_runCommandStream',
    displayName: 'Run Command (Streaming)',
    description:
        'Spawn a shell command and return a handle immediately. Use tomAi_readCommandOutput ' +
        'to poll for new stdout/stderr and exit code; tomAi_killCommand to terminate. ' +
        'Prefer tomAi_runCommand for short fire-and-forget commands.',
    tags: ['terminal', 'streaming', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['command'],
        properties: {
            command: { type: 'string' },
            cwd: { type: 'string', description: 'Working directory. Default: workspace root.' },
            shell: { type: 'boolean', description: 'Run via shell. Default true.' },
            maxBufferLines: { type: 'number', description: 'Max buffered lines per stream. Default 2000.' },
        },
    },
    execute: executeRunCommandStream,
};

interface ReadCommandOutputInput { handle: string; since?: 'all' | 'new'; maxLines?: number }

async function executeReadCommandOutput(input: ReadCommandOutputInput): Promise<string> {
    const proc = PROCESS_REGISTRY.get(input.handle);
    if (!proc) { return JSON.stringify({ error: `Unknown handle: ${input.handle}` }); }
    const mode = input.since ?? 'new';
    const max = Math.max(10, input.maxLines ?? 500);

    const startOut = mode === 'new' ? proc.stdoutCursor : 0;
    const startErr = mode === 'new' ? proc.stderrCursor : 0;
    const out = proc.stdoutBuf.slice(startOut);
    const err = proc.stderrBuf.slice(startErr);
    const outSlice = out.slice(-max);
    const errSlice = err.slice(-max);
    proc.stdoutCursor = proc.stdoutBuf.length;
    proc.stderrCursor = proc.stderrBuf.length;

    return JSON.stringify({
        handle: proc.id,
        running: proc.endedAt === null,
        exitCode: proc.exitCode,
        signal: proc.signal,
        startedAt: new Date(proc.startedAt).toISOString(),
        endedAt: proc.endedAt ? new Date(proc.endedAt).toISOString() : null,
        stdout: outSlice.join('\n'),
        stderr: errSlice.join('\n'),
        stdoutLinesReturned: outSlice.length,
        stderrLinesReturned: errSlice.length,
        truncatedStdout: out.length > outSlice.length,
        truncatedStderr: err.length > errSlice.length,
    });
}

export const READ_COMMAND_OUTPUT_TOOL: SharedToolDefinition<ReadCommandOutputInput> = {
    name: 'tomAi_readCommandOutput',
    displayName: 'Read Command Output',
    description:
        'Read new or all output from a process started by tomAi_runCommandStream. ' +
        'By default returns only new lines since the last read (since=\"new\").',
    tags: ['terminal', 'streaming', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['handle'],
        properties: {
            handle: { type: 'string' },
            since: { type: 'string', enum: ['all', 'new'], description: 'Default "new".' },
            maxLines: { type: 'number', description: 'Max lines per stream. Default 500.' },
        },
    },
    execute: executeReadCommandOutput,
};

interface KillCommandInput { handle: string; signal?: string }

async function executeKillCommand(input: KillCommandInput): Promise<string> {
    const proc = PROCESS_REGISTRY.get(input.handle);
    if (!proc) { return JSON.stringify({ error: `Unknown handle: ${input.handle}` }); }
    if (proc.endedAt !== null) {
        return JSON.stringify({ handle: proc.id, alreadyExited: true, exitCode: proc.exitCode });
    }
    try {
        proc.child.kill((input.signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
        return JSON.stringify({ handle: proc.id, killed: true, signal: input.signal ?? 'SIGTERM' });
    } catch (err: any) {
        return JSON.stringify({ error: `Kill failed: ${err?.message ?? err}` });
    }
}

export const KILL_COMMAND_TOOL: SharedToolDefinition<KillCommandInput> = {
    name: 'tomAi_killCommand',
    displayName: 'Kill Streaming Command',
    description: 'Send a signal (default SIGTERM) to a process started by tomAi_runCommandStream.',
    tags: ['terminal', 'streaming', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['handle'],
        properties: {
            handle: { type: 'string' },
            signal: { type: 'string', description: 'Signal name (e.g. SIGTERM, SIGKILL). Default SIGTERM.' },
        },
    },
    execute: executeKillCommand,
};

// ---------------------------------------------------------------------------
// tomAi_gitExec + tomAi_gitShow
// ---------------------------------------------------------------------------

const GIT_WRITE_ALLOWLIST: ReadonlySet<string> = new Set([
    'add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'branch', 'merge',
    'rebase', 'reset', 'restore', 'stash', 'tag', 'cherry-pick', 'revert',
    'switch', 'rm', 'mv', 'clean', 'apply', 'am', 'config',
]);

interface GitExecInput { subcommand: string; args?: string[]; cwd?: string; timeoutMs?: number }

async function executeGitExec(input: GitExecInput): Promise<string> {
    if (!input.subcommand) { return JSON.stringify({ error: 'subcommand is required' }); }
    if (!GIT_WRITE_ALLOWLIST.has(input.subcommand)) {
        return JSON.stringify({
            error: `Subcommand not in allow-list: "${input.subcommand}".`,
            allowed: Array.from(GIT_WRITE_ALLOWLIST).sort(),
        });
    }
    const cwd = input.cwd ? resolvePath(input.cwd) : wsRoot();
    if (!cwd) { return JSON.stringify({ error: 'No working directory available.' }); }
    const args = Array.isArray(input.args)
        ? input.args.filter((a): a is string => typeof a === 'string')
        : [];
    const timeout = Math.max(1000, input.timeoutMs ?? 60_000);
    try {
        const { stdout, stderr } = await execFileAsync('git', [input.subcommand, ...args], {
            cwd, maxBuffer: 8 * 1024 * 1024, timeout,
        });
        return JSON.stringify({ success: true, subcommand: input.subcommand, stdout, stderr }, null, 2);
    } catch (err: any) {
        return JSON.stringify({
            success: false,
            subcommand: input.subcommand,
            error: err?.message ?? String(err),
            stdout: err?.stdout ?? '',
            stderr: err?.stderr ?? '',
            exitCode: err?.code ?? null,
        });
    }
}

export const GIT_EXEC_TOOL: SharedToolDefinition<GitExecInput> = {
    name: 'tomAi_gitExec',
    displayName: 'Git Exec (Write)',
    description:
        'Run a git write command (add/commit/push/branch/checkout/merge/rebase/etc.). ' +
        'Allow-listed subcommands only. Approval required.',
    tags: ['git', 'execution', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['subcommand'],
        properties: {
            subcommand: { type: 'string', description: 'Git subcommand (see allow-list in error message).' },
            args: { type: 'array', items: { type: 'string' } },
            cwd: { type: 'string', description: 'Working directory. Default: workspace root.' },
            timeoutMs: { type: 'number', description: 'Timeout in ms. Default 60000.' },
        },
    },
    execute: executeGitExec,
};

interface GitShowInput { ref: string; filePath?: string; cwd?: string }

async function executeGitShow(input: GitShowInput): Promise<string> {
    if (!input.ref) { return JSON.stringify({ error: 'ref is required' }); }
    const cwd = input.cwd ? resolvePath(input.cwd) : wsRoot();
    if (!cwd) { return JSON.stringify({ error: 'No working directory available.' }); }
    const target = input.filePath ? `${input.ref}:${input.filePath}` : input.ref;
    try {
        const { stdout, stderr } = await execFileAsync('git', ['show', target], {
            cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
        });
        return JSON.stringify({ ref: input.ref, filePath: input.filePath, stdout, stderr }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: err?.message ?? String(err), stderr: err?.stderr ?? '' });
    }
}

export const GIT_SHOW_TOOL: SharedToolDefinition<GitShowInput> = {
    name: 'tomAi_gitShow',
    displayName: 'Git Show',
    description:
        'Run `git show <ref>` or `git show <ref>:<path>` to inspect a commit or a file at a revision.',
    tags: ['git', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['ref'],
        properties: {
            ref: { type: 'string', description: 'Commit / branch / tag ref.' },
            filePath: { type: 'string', description: 'Optional file path at the ref.' },
            cwd: { type: 'string', description: 'Working directory. Default: workspace root.' },
        },
    },
    execute: executeGitShow,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WAVE_C_TOOLS: SharedToolDefinition<any>[] = [
    APPLY_EDIT_TOOL,
    GET_CODE_ACTIONS_CACHED_TOOL,
    APPLY_CODE_ACTION_TOOL,
    RENAME_TOOL,
    VSCODE_META_TOOL,
    RUN_TASK_TOOL,
    RUN_DEBUG_CONFIG_TOOL,
    RUN_COMMAND_STREAM_TOOL,
    READ_COMMAND_OUTPUT_TOOL,
    KILL_COMMAND_TOOL,
    GIT_EXEC_TOOL,
    GIT_SHOW_TOOL,
];
