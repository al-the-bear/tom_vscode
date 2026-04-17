/**
 * Task & debug tools — run tasks.json tasks, launch launch.json debug configs.
 */

import * as vscode from 'vscode';
import { SharedToolDefinition } from './shared-tool-registry';

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
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TASK_DEBUG_TOOLS: SharedToolDefinition<any>[] = [
    RUN_TASK_TOOL,
    RUN_DEBUG_CONFIG_TOOL,
];
