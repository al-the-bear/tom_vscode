/**
 * Task & debug tools — `tomAi_runTask` and `tomAi_runDebugConfig`.
 *
 * Refactored for coverage entry #5:
 *
 *   - **vscode-free at runtime.** Impls take narrow dep interfaces
 *     (`TaskRunner`, `DebugRunner`) that the test passes as plain
 *     objects. The executor wrappers in `tool-executors.ts` bridge
 *     `vscode.tasks` / `vscode.debug` to those interfaces.
 *   - **Output-capture limitation documented** up front. VS Code's
 *     `vscode.tasks` API surfaces the exit code on
 *     `onDidEndTaskProcess` but not the stdout/stderr of the underlying
 *     terminal — capturing that would require a custom `Pseudoterminal`
 *     wrapper around every executed task. Until that lands, the
 *     description states explicitly that only the exit code is
 *     returned; the LLM is told to check the integrated terminal
 *     itself for the actual error output.
 *   - **Ambiguity surfacing**. When multiple tasks share a name (e.g.
 *     a workspace task and a folder-scoped task), the response now
 *     lists all matches so the model can disambiguate by scope —
 *     instead of silently picking the first one.
 *   - **List mode**. Calling `runTask` with `name: undefined` or
 *     `name: ""` no longer errors; it returns the inventory of
 *     available tasks. Same pattern as the guideline tools: omitted
 *     subject means "show me what's available". Saves a round-trip
 *     when the model doesn't know the exact name.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ---------------------------------------------------------------------------
// Narrow dep interfaces — production bridges to vscode.tasks / vscode.debug
// ---------------------------------------------------------------------------

/**
 * Minimal projection of a VS Code Task. We only surface the fields the
 * impl cares about (name, source/origin for disambiguation) so test
 * fakes don't have to construct full `vscode.Task` instances.
 */
export interface TaskInfo {
    name: string;
    /** Source label — usually "Workspace" or the extension that contributed it. */
    source?: string;
    /** Type from tasks.json (`shell`, `process`, `npm`, …). */
    type?: string;
    /** Scope hint — workspace folder name when folder-scoped, else "Workspace". */
    scopeName?: string;
}

export interface TaskExecResult {
    /** Exit code of the underlying process, null if unknown (custom executions). */
    exitCode: number | null;
    timedOut: boolean;
}

export interface TaskRunner {
    /** List every task discoverable in the current workspace + extensions. */
    listTasks(): Promise<TaskInfo[]>;
    /**
     * Execute `task` and (optionally) await its end. The implementation
     * is responsible for wiring `onDidEndTaskProcess` + the timeout —
     * we don't expose those raw here because tests would have to
     * synthesize event-emitter shapes for no benefit.
     */
    runTask(task: TaskInfo, opts: { waitForExit: boolean; timeoutMs: number }): Promise<TaskExecResult | { started: true }>;
}

// ---

export interface DebugRunner {
    /** Names of the available workspace folders (for the `folder` selector). */
    listFolders(): string[];
    /**
     * Start the named debug configuration in the given folder
     * (or the first folder when `folderName` is undefined). Returns
     * the started session's identifying name, or `null` if start
     * failed (config not found, validation error, etc.).
     */
    startDebug(configName: string, folderName: string | undefined, opts: { waitForExit: boolean; timeoutMs: number }):
        Promise<{ started: false; reason: string } | { started: true; sessionName: string | null; timedOut: boolean }>;
}

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

export interface RunTaskInput {
    /** Omit (or pass empty) to list available tasks instead of running one. */
    name?: string;
    waitForExit?: boolean;
    timeoutMs?: number;
}

const RUN_TASK_DEFAULT_TIMEOUT = 5 * 60 * 1000;

export async function runTaskImpl(deps: TaskRunner, input: RunTaskInput): Promise<string> {
    let tasks: TaskInfo[];
    try {
        tasks = await deps.listTasks();
    } catch (err) {
        return JSON.stringify({ error: `Failed to enumerate tasks: ${(err as Error).message}` });
    }
    if (!input.name) {
        // List mode — saves the model a round-trip when it's exploring.
        return JSON.stringify({
            listOnly: true,
            availableTasks: tasks.map((t) => describeTask(t)),
        });
    }
    const matches = matchTasks(tasks, input.name);
    if (matches.length === 0) {
        return JSON.stringify({
            error: `Task not found: "${input.name}"`,
            availableTasks: tasks.map((t) => describeTask(t)),
        });
    }
    if (matches.length > 1) {
        // Ambiguity surfaced rather than silently first-match.
        return JSON.stringify({
            error: `Task name "${input.name}" matched ${matches.length} tasks. Disambiguate by scope.`,
            matches: matches.map((t) => describeTask(t)),
        });
    }
    const task = matches[0];
    const waitForExit = input.waitForExit !== false;
    const timeoutMs = Math.max(1000, input.timeoutMs ?? RUN_TASK_DEFAULT_TIMEOUT);
    try {
        const result = await deps.runTask(task, { waitForExit, timeoutMs });
        if ('started' in result && result.started === true && !('exitCode' in result)) {
            return JSON.stringify({
                task: task.name,
                started: true,
                note: 'waitForExit=false — call `tomAi_runTask` again with the same name and `waitForExit: true` to await completion, or check the integrated terminal for live output.',
            });
        }
        const r = result as TaskExecResult;
        return JSON.stringify({
            task: task.name,
            exitCode: r.exitCode,
            timedOut: r.timedOut,
            outputNote: 'Task stdout/stderr is shown in the integrated terminal, not captured by this tool. Check the terminal for the actual error output if `exitCode !== 0`.',
        });
    } catch (err) {
        return JSON.stringify({ error: `Run task failed: ${(err as Error).message}` });
    }
}

// ---------------------------------------------------------------------------
// runDebugConfig
// ---------------------------------------------------------------------------

export interface RunDebugConfigInput {
    configName: string;
    folder?: string;
    waitForExit?: boolean;
    timeoutMs?: number;
}

const RUN_DEBUG_DEFAULT_TIMEOUT = 10 * 60 * 1000;

export async function runDebugConfigImpl(deps: DebugRunner, input: RunDebugConfigInput): Promise<string> {
    if (!input.configName) {
        return JSON.stringify({ error: '`configName` is required.' });
    }
    if (input.folder) {
        const folders = deps.listFolders();
        if (!folders.includes(input.folder)) {
            return JSON.stringify({
                error: `Folder not found: "${input.folder}"`,
                availableFolders: folders,
            });
        }
    }
    const waitForExit = input.waitForExit !== false;
    const timeoutMs = Math.max(1000, input.timeoutMs ?? RUN_DEBUG_DEFAULT_TIMEOUT);
    try {
        const result = await deps.startDebug(input.configName, input.folder, { waitForExit, timeoutMs });
        if (!result.started) {
            return JSON.stringify({
                error: `Failed to start debug config "${input.configName}": ${result.reason}`,
            });
        }
        if (!waitForExit) {
            return JSON.stringify({
                started: true,
                configName: input.configName,
                note: 'waitForExit=false — the debug session is running; check the Run & Debug view for status.',
            });
        }
        return JSON.stringify({
            configName: input.configName,
            sessionName: result.sessionName,
            timedOut: result.timedOut,
            outputNote: 'Debug output (DAP messages, console) is shown in the Debug Console, not captured by this tool.',
        });
    } catch (err) {
        return JSON.stringify({ error: `Debug start failed: ${(err as Error).message}` });
    }
}

// ---------------------------------------------------------------------------
// Tool defs (execute() installed by tool-executors.ts)
// ---------------------------------------------------------------------------

export const RUN_TASK_DESCRIPTION =
    'Execute a task defined in the workspace `tasks.json` by name. Matching is ' +
    'exact first, then case-insensitive. **Multiple tasks with the same name are ' +
    'NOT silently picked** — the response lists every match so you can disambiguate ' +
    'by scope on the next call. **Omit `name` (or pass empty)** to receive the ' +
    'inventory of available tasks instead of running one — useful when you don\'t ' +
    'know the exact name yet. Default `waitForExit: true` blocks until the task ' +
    'completes (timeout default 300 s) and returns the exit code. **Task ' +
    'stdout/stderr is NOT captured** by this tool — VS Code\'s Task API only ' +
    'surfaces the exit code. Check the integrated terminal for the actual output ' +
    'when a task fails.';

export const RUN_TASK_TOOL: SharedToolDefinition<RunTaskInput> = {
    name: 'tomAi_runTask',
    displayName: 'Run VS Code Task',
    description: RUN_TASK_DESCRIPTION,
    tags: ['tasks', 'execution', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Task name. Omit to list available tasks instead of running one.' },
            waitForExit: { type: 'boolean', description: 'Wait for task completion. Default true.' },
            timeoutMs: { type: 'number', description: 'Max wait time in ms (default 300000 / 5 min).' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

export const RUN_DEBUG_CONFIG_DESCRIPTION =
    'Launch a debug configuration from `launch.json` by name. Pass `folder` ' +
    '(workspace-folder name) to disambiguate when multiple folders define the ' +
    'same configuration; defaults to the first workspace folder. Default ' +
    '`waitForExit: true` blocks until the debug session ends (timeout default ' +
    '600 s) and returns the session name. **Debug output (DAP messages, console ' +
    'logs, exceptions) is NOT captured** by this tool — VS Code routes it to the ' +
    'Debug Console panel. Check that panel for actual diagnostic output. Errors ' +
    'on start (config not found, validation failure) are surfaced with a `reason` ' +
    'in the response.';

export const RUN_DEBUG_CONFIG_TOOL: SharedToolDefinition<RunDebugConfigInput> = {
    name: 'tomAi_runDebugConfig',
    displayName: 'Run Debug Configuration',
    description: RUN_DEBUG_CONFIG_DESCRIPTION,
    tags: ['debug', 'execution', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['configName'],
        properties: {
            configName: { type: 'string', description: 'Debug configuration name from launch.json.' },
            folder: { type: 'string', description: 'Workspace folder name (disambiguator). Default: first folder.' },
            waitForExit: { type: 'boolean', description: 'Wait for session termination. Default true.' },
            timeoutMs: { type: 'number', description: 'Max wait time in ms (default 600000 / 10 min).' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ---------------------------------------------------------------------------
// Matching + formatting helpers
// ---------------------------------------------------------------------------

/**
 * Match `name` against the task list. Exact match wins; if none,
 * fall back to case-insensitive. Returns every task that matches the
 * selected tier — so multiple workspace folders defining the same
 * task name produce multiple matches and the caller disambiguates.
 */
function matchTasks(tasks: TaskInfo[], name: string): TaskInfo[] {
    const exact = tasks.filter((t) => t.name === name);
    if (exact.length > 0) { return exact; }
    const ci = tasks.filter((t) => t.name.toLowerCase() === name.toLowerCase());
    return ci;
}

function describeTask(t: TaskInfo): string {
    const parts: string[] = [t.name];
    const meta: string[] = [];
    if (t.scopeName) { meta.push(`scope: ${t.scopeName}`); }
    if (t.source) { meta.push(`source: ${t.source}`); }
    if (t.type) { meta.push(`type: ${t.type}`); }
    if (meta.length > 0) { parts.push(`(${meta.join(', ')})`); }
    return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TASK_DEBUG_TOOLS: SharedToolDefinition<any>[] = [
    RUN_TASK_TOOL,
    RUN_DEBUG_CONFIG_TOOL,
];
