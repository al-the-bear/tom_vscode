/**
 * Wave D — notebook + advanced agent ops.
 *
 * See `doc/llm_tools.md` §6.3 Wave D.
 *
 * Integration points for host handlers:
 *   - Plan-mode flag is read by callers via `isPlanModeActive()` from this module.
 *   - Sub-agent spawner is plugged in via `registerSubagentSpawner(fn)`; until a
 *     spawner is registered, tomAi_spawnSubagent returns an instructive error.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

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

// ---------------------------------------------------------------------------
// Plan mode — global state flag
// ---------------------------------------------------------------------------

let PLAN_MODE_ACTIVE = false;
let PLAN_MODE_ENTERED_AT: number | null = null;
let PLAN_MODE_REASON: string | undefined;

export function isPlanModeActive(): boolean { return PLAN_MODE_ACTIVE; }
export function getPlanModeState(): { active: boolean; enteredAt: number | null; reason?: string } {
    return { active: PLAN_MODE_ACTIVE, enteredAt: PLAN_MODE_ENTERED_AT, reason: PLAN_MODE_REASON };
}

interface EnterPlanModeInput { reason?: string }

async function executeEnterPlanMode(input: EnterPlanModeInput): Promise<string> {
    PLAN_MODE_ACTIVE = true;
    PLAN_MODE_ENTERED_AT = Date.now();
    PLAN_MODE_REASON = input.reason;
    return JSON.stringify({
        planMode: 'entered',
        enteredAt: new Date(PLAN_MODE_ENTERED_AT).toISOString(),
        reason: input.reason ?? null,
        note: 'Approval-gated tools are still executable; plan mode is a signal to prefer reading/thinking over acting. Host handler may tighten enforcement.',
    });
}

export const ENTER_PLAN_MODE_TOOL: SharedToolDefinition<EnterPlanModeInput> = {
    name: 'tomAi_enterPlanMode',
    displayName: 'Enter Plan Mode',
    description:
        'Signal that the model is planning and should avoid mutating tools. Mirrors the Agent SDK\'s plan mode on the direct transport.',
    tags: ['planning', 'state', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: 'Why you are entering plan mode.' },
        },
    },
    execute: executeEnterPlanMode,
};

interface ExitPlanModeInput { plan?: string }

async function executeExitPlanMode(input: ExitPlanModeInput): Promise<string> {
    const wasActive = PLAN_MODE_ACTIVE;
    const durationMs = PLAN_MODE_ENTERED_AT ? Date.now() - PLAN_MODE_ENTERED_AT : null;
    PLAN_MODE_ACTIVE = false;
    PLAN_MODE_ENTERED_AT = null;
    PLAN_MODE_REASON = undefined;
    return JSON.stringify({
        planMode: 'exited',
        wasActive,
        durationMs,
        plan: input.plan ?? null,
    });
}

export const EXIT_PLAN_MODE_TOOL: SharedToolDefinition<ExitPlanModeInput> = {
    name: 'tomAi_exitPlanMode',
    displayName: 'Exit Plan Mode',
    description:
        'Signal that planning is done and execution can proceed. Optionally attach the final plan text.',
    tags: ['planning', 'state', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            plan: { type: 'string', description: 'Summary of the plan the model has arrived at.' },
        },
    },
    execute: executeExitPlanMode,
};

// ---------------------------------------------------------------------------
// Sub-agent spawner — plug-in point
// ---------------------------------------------------------------------------

export interface SubagentSpawnOptions {
    prompt: string;
    systemPrompt?: string;
    enabledTools?: string[];
    maxRounds?: number;
    temperature?: number;
}

export interface SubagentSpawnResult {
    summary: string;
    rounds: number;
    toolCalls: number;
    stopReason?: string;
}

type SubagentSpawner = (options: SubagentSpawnOptions) => Promise<SubagentSpawnResult>;

let SUBAGENT_SPAWNER: SubagentSpawner | null = null;

export function registerSubagentSpawner(fn: SubagentSpawner | null): void {
    SUBAGENT_SPAWNER = fn;
}

interface SpawnSubagentInput {
    prompt: string;
    systemPrompt?: string;
    enabledTools?: string[];
    maxRounds?: number;
    temperature?: number;
}

async function executeSpawnSubagent(input: SpawnSubagentInput): Promise<string> {
    if (!input.prompt) { return JSON.stringify({ error: 'prompt is required' }); }
    if (!SUBAGENT_SPAWNER) {
        return JSON.stringify({
            error: 'Sub-agent spawner is not registered.',
            hint: 'The Anthropic handler must call registerSubagentSpawner() at activation to wire this tool. On the Agent SDK transport, prefer the built-in Task tool (enable useBuiltInTools in the profile).',
        });
    }
    try {
        const result = await SUBAGENT_SPAWNER({
            prompt: input.prompt,
            systemPrompt: input.systemPrompt,
            enabledTools: input.enabledTools,
            maxRounds: input.maxRounds,
            temperature: input.temperature,
        });
        return JSON.stringify(result, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Sub-agent failed: ${err?.message ?? err}` });
    }
}

export const SPAWN_SUBAGENT_TOOL: SharedToolDefinition<SpawnSubagentInput> = {
    name: 'tomAi_spawnSubagent',
    displayName: 'Spawn Sub-Agent',
    description:
        'Run a sub-agent conversation with a narrower system prompt and tool set; returns the final summary. ' +
        'On the Agent SDK transport, prefer the built-in Task tool. ' +
        'Requires the host handler to register a spawner; until registered this tool reports an integration error.',
    tags: ['agent', 'delegation', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
            prompt: { type: 'string', description: 'Task for the sub-agent.' },
            systemPrompt: { type: 'string', description: 'Optional system prompt override.' },
            enabledTools: { type: 'array', items: { type: 'string' }, description: 'Tool-name allow-list for the sub-agent.' },
            maxRounds: { type: 'number', description: 'Max tool-use rounds. Default 10.' },
            temperature: { type: 'number', description: 'Optional temperature override.' },
        },
    },
    execute: executeSpawnSubagent,
};

// ---------------------------------------------------------------------------
// tomAi_notebookEdit
// ---------------------------------------------------------------------------

interface NotebookCellInput { kind: 'code' | 'markdown'; text: string; language?: string }

interface NotebookEditOp {
    op: 'insert' | 'replace' | 'delete';
    index?: number;
    endIndex?: number;
    cells?: NotebookCellInput[];
}

interface NotebookEditInput { filePath: string; operations: NotebookEditOp[] }

function toCellData(c: NotebookCellInput): vscode.NotebookCellData {
    const kind = c.kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
    const language = c.language ?? (c.kind === 'markdown' ? 'markdown' : 'python');
    return new vscode.NotebookCellData(kind, c.text ?? '', language);
}

async function executeNotebookEdit(input: NotebookEditInput): Promise<string> {
    if (!input.filePath) { return JSON.stringify({ error: 'filePath is required' }); }
    const abs = resolvePath(input.filePath);
    if (!fs.existsSync(abs)) { return JSON.stringify({ error: `Notebook not found: ${abs}` }); }
    const uri = vscode.Uri.file(abs);

    let doc: vscode.NotebookDocument;
    try { doc = await vscode.workspace.openNotebookDocument(uri); }
    catch (err: any) { return JSON.stringify({ error: `Could not open notebook: ${err?.message ?? err}` }); }

    const edit = new vscode.WorkspaceEdit();
    const edits: vscode.NotebookEdit[] = [];
    for (const op of input.operations) {
        try {
            if (op.op === 'insert') {
                if (typeof op.index !== 'number') { return JSON.stringify({ error: 'insert requires index' }); }
                if (!op.cells?.length) { return JSON.stringify({ error: 'insert requires cells' }); }
                edits.push(vscode.NotebookEdit.insertCells(op.index, op.cells.map(toCellData)));
            } else if (op.op === 'replace') {
                if (typeof op.index !== 'number') { return JSON.stringify({ error: 'replace requires index' }); }
                const end = op.endIndex ?? op.index + 1;
                edits.push(vscode.NotebookEdit.replaceCells(
                    new vscode.NotebookRange(op.index, end),
                    (op.cells ?? []).map(toCellData),
                ));
            } else if (op.op === 'delete') {
                if (typeof op.index !== 'number') { return JSON.stringify({ error: 'delete requires index' }); }
                const end = op.endIndex ?? op.index + 1;
                edits.push(vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(op.index, end)));
            } else {
                return JSON.stringify({ error: `Unknown op: ${op.op}` });
            }
        } catch (err: any) {
            return JSON.stringify({ error: `Failed to prepare ${op.op}: ${err?.message ?? err}` });
        }
    }
    edit.set(uri, edits);
    try {
        const applied = await vscode.workspace.applyEdit(edit);
        return JSON.stringify({
            applied,
            operationCount: input.operations.length,
            cellCountAfter: doc.cellCount,
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Notebook edit failed: ${err?.message ?? err}` });
    }
}

export const NOTEBOOK_EDIT_TOOL: SharedToolDefinition<NotebookEditInput> = {
    name: 'tomAi_notebookEdit',
    displayName: 'Notebook Edit',
    description:
        'Insert / replace / delete cells in a Jupyter notebook. Operations are applied transactionally via a WorkspaceEdit.',
    tags: ['notebook', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'operations'],
        properties: {
            filePath: { type: 'string' },
            operations: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['op'],
                    properties: {
                        op: { type: 'string', enum: ['insert', 'replace', 'delete'] },
                        index: { type: 'number', description: 'Zero-based cell index.' },
                        endIndex: { type: 'number', description: 'Exclusive end index for replace/delete.' },
                        cells: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['kind', 'text'],
                                properties: {
                                    kind: { type: 'string', enum: ['code', 'markdown'] },
                                    text: { type: 'string' },
                                    language: { type: 'string', description: 'Cell language id. Default python (code) / markdown.' },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    execute: executeNotebookEdit,
};

// ---------------------------------------------------------------------------
// tomAi_notebookRun
// ---------------------------------------------------------------------------

interface NotebookRunInput { filePath: string; cellIndices?: number[]; runAll?: boolean }

async function executeNotebookRun(input: NotebookRunInput): Promise<string> {
    if (!input.filePath) { return JSON.stringify({ error: 'filePath is required' }); }
    const abs = resolvePath(input.filePath);
    if (!fs.existsSync(abs)) { return JSON.stringify({ error: `Notebook not found: ${abs}` }); }
    const uri = vscode.Uri.file(abs);
    try {
        const doc = await vscode.workspace.openNotebookDocument(uri);
        await vscode.window.showNotebookDocument(doc);

        if (input.runAll) {
            await vscode.commands.executeCommand('notebook.execute');
            return JSON.stringify({ ran: 'all', cellCount: doc.cellCount, note: 'Execution dispatched; outputs may still be streaming.' });
        }

        if (Array.isArray(input.cellIndices) && input.cellIndices.length > 0) {
            for (const idx of input.cellIndices) {
                if (idx < 0 || idx >= doc.cellCount) { continue; }
                await vscode.commands.executeCommand('notebook.cell.execute', { start: idx, end: idx + 1 });
            }
            return JSON.stringify({ ran: input.cellIndices, note: 'Execution dispatched; outputs may still be streaming.' });
        }

        return JSON.stringify({ error: 'Provide runAll=true or a non-empty cellIndices array.' });
    } catch (err: any) {
        return JSON.stringify({ error: `Notebook run failed: ${err?.message ?? err}` });
    }
}

export const NOTEBOOK_RUN_TOOL: SharedToolDefinition<NotebookRunInput> = {
    name: 'tomAi_notebookRun',
    displayName: 'Notebook Run',
    description:
        'Execute cells in a Jupyter notebook. Either runAll=true or a cellIndices array. ' +
        'Note: outputs stream asynchronously after dispatch; re-open the file to inspect results.',
    tags: ['notebook', 'execution', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['filePath'],
        properties: {
            filePath: { type: 'string' },
            cellIndices: { type: 'array', items: { type: 'number' } },
            runAll: { type: 'boolean' },
        },
    },
    execute: executeNotebookRun,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WAVE_D_TOOLS: SharedToolDefinition<any>[] = [
    ENTER_PLAN_MODE_TOOL,
    EXIT_PLAN_MODE_TOOL,
    SPAWN_SUBAGENT_TOOL,
    NOTEBOOK_EDIT_TOOL,
    NOTEBOOK_RUN_TOOL,
];
