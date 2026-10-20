/**
 * Every registered tool, called once through the standalone MCP server (qrf1).
 *
 * The server is the one the extension starts (buildToolMcpServer over the tool
 * set resolveEffectiveMcpTools serves an authenticated client: every tool in
 * ALL_SHARED_TOOLS), started in-process with the vscode stub and called by a
 * real MCP Client over an in-memory transport. The tools run their real
 * executors — the code the chat panels run in-process.
 *
 * The test mode is a SANDBOX: the workspace is a throwaway copy of a small
 * fixture workspace (a git repository with no remote, a quest with todos, a
 * spec, guidelines), HOME points into the sandbox, and outgoing HTTP is
 * refused, so writes are real but land in the sandbox and nothing leaves the
 * machine.
 *
 *   MA-1 the server lists every registered tool, its resources and prompts
 *   MA-2 every registered tool is called with a representative input and answers (a result or a tool error,
 *        never a hang or a protocol failure); the per-tool outcome is reported
 *   MA-3 the sandbox holds: a write tool's write lands in the sandbox, and after every tool ran, nothing
 *        changed outside it — the extension's repository and HOME are as they were, no request left
 *   MA-4 a handful of tools are checked for the RIGHT answer, not just an answer: a read sees the fixture, a
 *        write is read back, git sees its own commit
 *   MA-0 before the stores start: a queue tool answers the error, not `ok` — tomAi_removeQueueItem answered
 *        `ok` and left a rejection unhandled (found by this suite)
 */

/* eslint-disable @typescript-eslint/naming-convention -- the input and answer tables are keyed by tool name */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ---------------------------------------------------------------------------
// The sandbox — set up before any extension module is loaded, so every path
// a module computes at load time (HOME, the workspace root) is the sandbox's.
// ---------------------------------------------------------------------------

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-all-tools-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const REAL_HOME = os.homedir();
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const AI_BUILD = path.resolve(EXT_ROOT, '..', '..', 'ai_build');
const QUEST = 'demo';
const TODO_FILE = `todos.${QUEST}.todo.yaml`;
const SPEC = 'specs/meridian.docspecs.yaml';
const FR = 'SBP/introductionAndScope/requirements/functionalRequirements';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function seedFixture(): void {
    fs.mkdirSync(HOME, { recursive: true });
    put('README.md', '# Demo workspace\n\nThe fixture of the all-tools MCP test.\n');
    put('src/greeting.ts', 'export function greet(name: string): string {\n    return `hello ${name}`;\n}\n');
    put('notes/plain.md', '# Notes\n\nalpha beta gamma\n');
    put('notebook.ipynb', JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
    put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Quest Overview: Demo\n\n**Quest ID:** demo\n');
    put(`_ai/quests/${QUEST}/${TODO_FILE}`, [
        'todos:',
        '  - id: demo1_aaaa-first',
        '    title: The first todo',
        '    description: A todo the tools read, move and archive.',
        '    status: not-started',
        '    priority: medium',
        '  - id: demo2_aaaa-done',
        '    title: A completed todo',
        '    description: Archived by the test.',
        '    status: completed',
        '    priority: low',
        '',
    ].join('\n'));
    put('_copilot_guidelines/index.md', '# Guidelines\n\nThe fixture guidelines.\n');
    put('_copilot_guidelines/pattern_prompts/continue.md', 'Continue the work.\n');
    put('pkg/_copilot_guidelines/index.md', '# Package guidelines\n');
    put('notes/doc.md', '<!-- docspec: none -->\n# <!--[notes]--> Notes\n\nalpha beta\n\n## <!--[more]--> More\n\ngamma\n');
    put('.tom/tom_vscode_extension.json', '{}\n');
    put(`${QUEST}.code-workspace`, '{ "folders": [{ "path": "." }] }\n');
    put('_ai/processes/flow/flow.process.yaml', [
        'id: flow', 'name: Flow', 'phases:', '  - id: build', '    steps:', '      - id: code', '      - id: review',
        '        repeatable: true', '    gate:', '      id: gate', '',
    ].join('\n'));
    put('_ai/processes/flow/flow.md', '# Flow\n\nBuild, then review.\n');
    put(SPEC, fs.readFileSync(path.join(AI_BUILD, 'tom_som_dart_v0', 'documents', 'meridian_order_management.docspecs.yaml'), 'utf8'));
    git(WS, 'init', '-q');
    git(WS, 'config', 'user.email', 'mcp-test@example.invalid');
    git(WS, 'config', 'user.name', 'mcp test');
    git(WS, 'config', 'commit.gpgsign', 'false');
    git(WS, 'add', '.');
    git(WS, 'commit', '-qm', 'fixture');
}
seedFixture();
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

// Outgoing HTTP is refused: a tool that would leave the machine gets an error instead.
const refusedRequests: string[] = [];
function refuse(scheme: string) {
    return (...args: unknown[]): never => {
        const a = args[0] as { hostname?: string; host?: string } | string | URL;
        refusedRequests.push(`${scheme} ${typeof a === 'string' || a instanceof URL ? String(a) : (a.hostname ?? a.host ?? '?')}`);
        throw new Error('network access is refused in the MCP test sandbox');
    };
}
// The module objects themselves (an `import * as` namespace is read-only); every importer reads through them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
for (const scheme of ['http', 'https']) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(scheme) as Record<string, unknown>;
    mod.request = refuse(scheme);
    mod.get = refuse(scheme);
}
globalThis.fetch = (async (input: unknown) => refuse('fetch')(String(input))) as unknown as typeof fetch;

// Every path the tools write through fs, recorded so MA-3 can show it is in the sandbox.
const writes: string[] = [];
function recordWrites(): void {
    const record = (p: unknown): void => {
        if (typeof p === 'string') { writes.push(path.resolve(p)); } else if (p instanceof URL) { writes.push(p.pathname); }
    };
    const one = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'createWriteStream', 'truncateSync'];
    const two = ['renameSync', 'copyFileSync', 'cpSync', 'symlinkSync'];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const target = require('fs') as Record<string, (...a: unknown[]) => unknown>;
    const wrap = (obj: Record<string, (...a: unknown[]) => unknown>, name: string, both: boolean): void => {
        const orig = obj[name];
        if (typeof orig !== 'function') { return; }
        obj[name] = function (this: unknown, ...a: unknown[]) { record(a[0]); if (both) { record(a[1]); } return orig.apply(this, a); };
    };
    for (const n of one) { wrap(target, n, false); }
    for (const n of two) { wrap(target, n, true); }
    for (const n of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rm', 'rmdir', 'truncate']) { wrap(target, n, false); }
    for (const n of ['rename', 'copyFile', 'cp', 'symlink']) { wrap(target, n, true); }
    const promises = target.promises as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const n of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rm', 'rmdir', 'truncate']) { wrap(promises, n, false); }
    for (const n of ['rename', 'copyFile', 'cp', 'symlink']) { wrap(promises, n, true); }
}

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
// The window has the quest's workspace file open, as the extension does.
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { buildToolMcpServer, NULL_MCP_TRAIL_SINK, resolveEffectiveMcpTools } from '../../handlers/mcpServer-handler.js';
import { ALL_SHARED_TOOLS } from '../tool-executors.js';
import type { ResolvedMcpServerSettings } from '../../utils/sendToChatConfig.js';
import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { SessionTodoStore } from '../../managers/sessionTodoStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TrailService } from '../../services/trailService.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { AskUserRegistry } from '../../services/askUserRegistry.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';

const KEY_ENV = 'TOM_MCP_ALL_TOOLS_KEY';
const env = { [KEY_ENV]: 'all-tools-secret' };
const settings: ResolvedMcpServerSettings = {
    enabled: true, host: '127.0.0.1', basePort: 19930, apiKeyEnv: KEY_ENV,
    allowWriteWithoutAuth: false, toolsEnabled: true, enabledTools: [],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Outcome { tool: string; ok: boolean; ms: number; text: string }

/** A call that does not answer in this time is a hang, and fails MA-2. */
const CALL_TIMEOUT_MS = 8000;

/**
 * The input each tool is called with. A tool not named here gets one built
 * from its schema's required fields. These name real things of the fixture,
 * and keep the tools that would wait for a person, start something or leave
 * the machine short and inside the sandbox.
 */
type Input = Json | ((prev: Record<string, Json>) => Json);

/** The first value of one of `keys` anywhere in an earlier answer: the id a create returned. */
function find(answer: Json, ...keys: string[]): Json {
    if (answer === null || typeof answer !== 'object') { return undefined; }
    for (const k of keys) { if (answer[k] !== undefined && typeof answer[k] !== 'object') { return answer[k]; } }
    for (const v of Object.values(answer)) {
        const hit = find(v, ...keys);
        if (hit !== undefined) { return hit; }
    }
    return undefined;
}

function inputs(): Record<string, Input> {
    const todo = (id: string) => ({ questId: QUEST, todoId: id });
    const queued = (p: Record<string, Json>) => find(p.tomAi_addQueueItem, 'id');
    const followUp = (p: Record<string, Json>) => find(p.tomAi_addQueueFollowUp?.followUps ?? p.tomAi_addQueueFollowUp, 'followUpId', 'id');
    const timed = (p: Record<string, Json>) => find(p.tomAi_addTimedRequest, 'id', 'entryId');
    const reminder = (p: Record<string, Json>) => find(p.tomAi_createReminderTemplate, 'id');
    const sessionTodo = (p: Record<string, Json>) => find(p.tomAi_addSessionTodo, 'id');
    const handle = (p: Record<string, Json>) => find(p.tomAi_runCommandStream, 'handle');
    return {
        tomAi_addQueueItem: { text: 'a prompt queued by the MCP test' },
        tomAi_addQueueFollowUp: (p: Record<string, Json>) => ({ queueItemId: queued(p), text: 'a follow-up' }),
        tomAi_addQueuePrePrompt: (p: Record<string, Json>) => ({ queueItemId: queued(p), text: 'a pre-prompt' }),
        tomAi_updateQueuePrePrompt: (p: Record<string, Json>) => ({ queueItemId: queued(p), index: 0, text: 'the pre-prompt, changed' }),
        tomAi_removeQueuePrePrompt: (p: Record<string, Json>) => ({ queueItemId: queued(p), index: 0 }),
        tomAi_updateQueueItem: (p: Record<string, Json>) => ({ queueItemId: queued(p), text: 'the queued prompt, changed' }),
        tomAi_setQueueItemStatus: (p: Record<string, Json>) => ({ queueItemId: queued(p), status: 'staged' }),
        tomAi_updateQueueFollowUp: (p: Record<string, Json>) => ({ queueItemId: queued(p), followUpId: followUp(p), text: 'the follow-up, changed' }),
        tomAi_removeQueueFollowUp: (p: Record<string, Json>) => ({ queueItemId: queued(p), followUpId: followUp(p) }),
        tomAi_removeQueueItem: (p: Record<string, Json>) => ({ queueItemId: queued(p) }),
        tomAi_sendQueuedPrompt: { queueItemId: 'no-such-item' },
        tomAi_resendQueueItem: { queueItemId: 'no-such-item' },
        tomAi_addTimedRequest: { text: 'a timed prompt from the MCP test', intervalMinutes: 60 },
        tomAi_updateTimedRequest: (p: Record<string, Json>) => ({ entryId: timed(p), patch: { intervalMinutes: 90 } }),
        tomAi_removeTimedRequest: (p: Record<string, Json>) => ({ entryId: timed(p) }),
        tomAi_createReminderTemplate: { name: 'MCP test reminder', prompt: 'Still there after {{waitingMinutes}} minutes?' },
        tomAi_updateReminderTemplate: (p: Record<string, Json>) => ({ id: reminder(p), name: 'MCP test reminder, renamed' }),
        tomAi_deleteReminderTemplate: (p: Record<string, Json>) => ({ id: reminder(p) }),
        tomAi_createPromptTemplate: { name: 'mcp-test', template: 'Sandbox: ${originalPrompt}' },
        tomAi_updatePromptTemplate: { name: 'mcp-test', template: 'Sandbox, changed: ${originalPrompt}' },
        tomAi_deletePromptTemplate: { name: 'mcp-test' },
        tomAi_addSessionTodo: { title: 'a session todo from the MCP test' },
        tomAi_updateSessionTodo: (p: Record<string, Json>) => ({ id: sessionTodo(p), status: 'done' }),
        tomAi_deleteSessionTodo: (p: Record<string, Json>) => ({ id: sessionTodo(p) }),
        tomAi_readCommandOutput: (p: Record<string, Json>) => ({ handle: handle(p), since: 'all' }),
        tomAi_killCommand: (p: Record<string, Json>) => ({ handle: handle(p) }),
        tomAi_readFile: { filePath: 'README.md' },
        tomAi_listDirectory: { dirPath: '.' },
        tomAi_findFiles: { pattern: '**/*.md' },
        tomAi_findTextInFiles: { searchText: 'alpha' },
        tomAi_createFile: { filePath: 'created/by-test.md', content: 'written by the MCP test\n' },
        tomAi_editFile: { filePath: 'notes/plain.md', oldText: 'alpha', newText: 'ALPHA' },
        tomAi_multiEditFile: { edits: [{ filePath: 'notes/plain.md', oldText: 'gamma', newText: 'GAMMA' }] },
        tomAi_moveFile: { from: 'created/by-test.md', to: 'created/moved.md' },
        tomAi_deleteFile: { path: 'created/moved.md' },
        tomAi_applyEdit: { operations: [
            { op: 'createFile', filePath: 'created/applied.md' },
            { op: 'insert', filePath: 'created/applied.md', position: { line: 1, character: 1 }, text: 'applied\n' },
        ] },
        tomAi_openFile: { filePath: 'README.md', line: 1 },
        tomAi_gotoDefinition: { filePath: 'src/greeting.ts', line: 1, character: 17 },
        tomAi_findReferences: { filePath: 'src/greeting.ts', line: 1, character: 17 },
        tomAi_getCodeActions: { filePath: 'src/greeting.ts', startLine: 1, startCharacter: 1 },
        tomAi_getCodeActionsCached: { filePath: 'src/greeting.ts', startLine: 1, startCharacter: 1 },
        tomAi_rename: { filePath: 'src/greeting.ts', line: 1, character: 17, newName: 'welcome' },
        tomAi_findSymbol: { query: 'greet' },
        tomAi_getPromptPair: { index: 0 },
        tomAi_listCommands: { filter: 'editor' },
        tomAi_runCommand: { command: 'echo sandbox' },
        tomAi_runCommandStream: { command: 'echo streamed' },
        tomAi_gitRead: { subcommand: 'log', args: ['--oneline', '-n', '3'] },
        tomAi_gitShow: { ref: 'HEAD' },
        tomAi_gitWrite: { subcommand: 'commit', args: ['--allow-empty', '-qm', 'written by the MCP test'] },
        tomAi_askUser: { questions: ['Is this the sandbox?'] },
        tomAi_askUserPicker: { items: ['yes', 'no'] },
        tomAi_askCopilot: { prompt: 'sandbox', waitForAnswer: false },
        tomAi_askBigBrother: { operation: 'list' },
        tomAi_notifyUser: { message: 'from the MCP test', channel: 'vscode' },
        tomAi_fetchWebpage: { url: 'https://example.invalid/' },
        tomAi_webSearch: { query: 'sandbox' },
        tomAi_spawnSubagent: { prompt: 'sandbox', maxRounds: 1 },
        tomAi_listQuestTodos: { questId: QUEST },
        tomAi_getQuestTodo: todo('demo1_aaaa-first'),
        tomAi_getCombinedTodos: { questId: QUEST },
        tomAi_createQuestTodo: { questId: QUEST, todo: { id: 'demo3_aaaa-created', title: 'Created', description: 'by the test', status: 'not-started' } },
        tomAi_updateQuestTodo: { ...todo('demo3_aaaa-created'), updates: { priority: 'high' } },
        tomAi_moveQuestTodo: { ...todo('demo3_aaaa-created'), targetFile: `topic.${QUEST}.todo.yaml` },
        tomAi_deleteQuestTodo: todo('demo3_aaaa-created'),
        tomAi_archiveQuestTodos: { questId: QUEST, todoIds: ['demo2_aaaa-done'] },
        tomAi_deleteQuestTodos: { questId: QUEST, todoIds: ['demo1_aaaa-first'] },
        tomAi_transferTodos: { todoIds: ['demo1_aaaa-first'], sourceQuestId: QUEST, toWorkspace: true },
        tomAi_readProjectGuideline: { projectPath: 'pkg' },
        tomAi_listProjectGuidelines: { projectPath: 'pkg' },
        tomAi_searchProjectGuidelines: { projectPath: 'pkg', query: 'Package' },
        tomAi_searchGlobalGuidelines: { query: 'fixture' },
        tomAi_readPatternPrompt: { name: 'continue' },
        tomAi_listDocuments: { category: 'guidelines' },
        tomAi_saveMemory: { content: 'a fact from the MCP test' },
        tomAi_updateMemory: { file: 'facts.md', heading: 'Test', content: 'updated' },
        tomAi_forgetMemory: { file: 'facts.md', heading: 'Test' },
        tomAi_writeChatVariable: { variables: { mcpTest: 'yes' } },
        tomAi_writeConversationResult: { content: 'result', conversationId: 'mcp-test' },
        tomAi_setTimerEngineState: { activated: false },
        tomAi_readChatVariable: { key: 'mcpTest' },
        tomAi_setProcessState: { process: 'flow' },
        tomAi_getProcess: { id: 'flow' },
        tomAi_notebookEdit: { filePath: 'notebook.ipynb', operations: [{ op: 'insert', index: 0, kind: 'markdown', source: '# cell' }] },
        tomAi_notebookRun: { filePath: 'notebook.ipynb', runAll: true },
        tomAi_runTask: {},
        tomAi_runDebugConfig: { configName: 'none', waitForExit: false },
        tomAi_runVscodeCommand: { command: 'workbench.action.files.save' },
        tomAi_runVscodeCommandTyped: { command: 'workbench.action.files.save', args: [] },
        tomAi_docspecsOutline: { file: 'notes/doc.md' },
        tomAi_docspecsValidate: { file: 'notes/doc.md' },
        tomAi_docspecsGetSection: { file: 'notes/doc.md', sectionId: 'more' },
        tomAi_docspecsReplaceSection: { file: 'notes/doc.md', sectionId: 'more', body: 'delta, written by the MCP test' },
        tomAi_specListDocuments: { dir: 'specs' },
        tomAi_specOutline: { file: SPEC },
        tomAi_specValidate: { file: SPEC },
        tomAi_specRender: { file: SPEC, path: 'SBP/introductionAndScope' },
        tomAi_specReflect: { path: 'SBP' },
        tomAi_specSearch: { file: SPEC, text: 'order', pageSize: 1 },
        tomAi_specAnnotations: { file: SPEC },
        tomAi_specExtractAnswers: { file: SPEC },
        tomAi_specWriteAnswers: { file: SPEC, output: 'specs/answers.md' },
        tomAi_specGetSection: { file: SPEC, path: 'SBP' },
        tomAi_specSetHeadline: { file: SPEC, path: 'SBP/introductionAndScope', headline: 'Introduction (by the MCP test)' },
        tomAi_specAddNode: { file: SPEC, parentPath: 'SBP/introductionAndScope/requirements/functionalRequirements', childSegment: 'FRE-REQU-LST', dryRun: true },
        tomAi_specApplyEdits: { file: SPEC, edits: [{ op: 'setHeadline', path: 'SBP/introductionAndScope', headline: 'Introduction' }], dryRun: true },
        tomAi_specSearchIterate: (p: Record<string, Json>) => ({ cursorId: p.tomAi_specSearch?.cursorId }),
        tomAi_specSetContent: { file: SPEC, path: 'SBP/content', text: 'Written by the MCP test.' },
        tomAi_specSetFormField: { file: SPEC, path: `${FR}/FRE-REQU-LST-1/FREP`, field: 'priority', value: 'could' },
        tomAi_specSetCodeSpec: { file: SPEC, path: `${FR}/FRE-REQU-LST-1`, codeSpec: 'CsMcpTest' },
        tomAi_specSetItemSectionId: { file: SPEC, itemPath: `${FR}/FRE-REQU-LST-1`, sectionId: 'FRE-REQU-MCP-TEST' },
        tomAi_specMoveListItem: { file: SPEC, itemPath: `${FR}/FRE-REQU-LST-1`, toIndex: 1 },
        tomAi_specRemoveListItem: { file: SPEC, itemPath: `${FR}/FRE-REQU-LST-2` },
        tomAi_specClearSection: { file: SPEC, path: 'SBP/introductionAndScope/summary/SYSCL' },
        tomAi_specInsertComment: { file: SPEC, path: 'SBP/content', afterParagraph: 0, text: 'A comment from the MCP test.', author: 'mcp' },
        tomAi_specInsertQuestion: (p: Record<string, Json>) => ({
            file: SPEC, afterComment: find(p.tomAi_specInsertComment, 'id'),
            question: { id: 'BQ-9001', topic: 'Sandbox', text: 'Is this the sandbox?', options: ['(a) yes', '(b) no'], recommended: 'a' },
        }),
        tomAi_specSetAnswer: { file: SPEC, questionId: 'BQ-9001', answer: '(a) because it is' },
        tomAi_specEditComment: (p: Record<string, Json>) => ({ file: SPEC, commentId: find(p.tomAi_specInsertComment, 'id'), text: 'The comment, edited.' }),
        tomAi_specAssignCommentIds: { file: SPEC },
        tomAi_specResolveAnnotation: { file: SPEC, id: 'BQ-9001' },
        tomAi_specDecideMarks: { file: SPEC, all: 'accept' },
        tomAi_specRemoveAllAnnotations: { file: SPEC },
        tomAi_specCodeSpecsGate: { file: SPEC },
        tomAi_specCodeSpecsRouting: { file: SPEC, limit: 5 },
        tomAi_specCodeSpecsExtract: { file: SPEC },
        tomAi_specCodeSpecsStatus: { file: SPEC, questId: QUEST },
        tomAi_specCodeSpecsWriteExtracts: { file: SPEC },
        tomAi_specCodeSpecsVerdicts: { file: SPEC },
        tomAi_specCodeSpecsSetVerdict: { file: SPEC, area: 'CE-EN', verdict: 'sufficient', note: 'set by the MCP test' },
        tomAi_specCodeSpecsPlanTodos: { questId: QUEST, file: SPEC, dryRun: true },
        tomAi_specCodeSpecsQueryExtracts: { file: SPEC },
        tomAi_specCodeSpecsTrace: { file: SPEC, specPath: 'SBP/introductionAndScope' },
        tomAi_specCodeSpecsStepContext: { file: SPEC, step: 1 },
        tomAi_specCodeSpecsValidate: { shared: 'specs/none_codespec_shared' },
        tomAi_specConvert: { file: SPEC, target: 'specs/meridian.md' },
        tomAi_specCreateDocument: { file: 'specs/new.docspecs.yaml', root: 'SBP' },
        tomAi_createSession: { name: 'mcp-test' },
    };
}

/**
 * The tools that wait for a person are answered as a person would answer
 * them: the ask through the registry the webview and Telegram submit to, the
 * picker by accepting its first item. Each answerer is polled until it could
 * answer.
 */
const ANSWERS: Record<string, { answer: () => boolean; expect: RegExp }> = {
    tomAi_askUser: {
        answer: () => {
            const pending = AskUserRegistry.instance.getPending();
            return pending !== undefined && AskUserRegistry.instance.submit(pending.requestId, 'yes, the sandbox', 'vscode');
        },
        expect: /yes, the sandbox/,
    },
    tomAi_askUserPicker: {
        answer: () => {
            const picks = (vscodeStub.stub.window as { __quickPicks: Array<{ visible: boolean; __accept(): void }> }).__quickPicks;
            const open = picks.find((q) => q.visible);
            if (!open) { return false; }
            open.__accept();
            return true;
        },
        expect: /"value":\s*"yes"/,
    },
};

async function answerWhenAsked(answer: () => boolean): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (answer()) { return; }
        await new Promise((r) => setTimeout(r, 10));
    }
}

/** An input from a schema's required fields, for the tools `inputs()` does not name. */
function fromSchema(schema: Json): Json {
    const out: Json = {};
    for (const key of (schema?.required ?? []) as string[]) {
        const p = schema.properties?.[key] ?? {};
        const type = Array.isArray(p.type) ? p.type[0] : p.type;
        out[key] = p.enum ? p.enum[0]
            : type === 'number' || type === 'integer' ? 1
            : type === 'boolean' ? false
            : type === 'array' ? []
            : type === 'object' ? {}
            : 'x';
    }
    return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
        p.finally(() => clearTimeout(timer)),
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms); }),
    ]);
}

function gitStatus(dir: string): string {
    try { return git(dir, 'status', '--porcelain', '--untracked-files=all'); } catch { return '(not a repository)'; }
}

/**
 * The extension's stores, started as activation starts them, on a context whose
 * storage lives in the sandbox — so the tools that keep their state there
 * (chat variables, session todos, the process position, the queue, timed
 * requests, reminder templates) run their real writes.
 */
const subscriptions: Array<{ dispose(): unknown }> = [];
function startStores(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    const context = {
        subscriptions,
        extensionPath: EXT_ROOT,
        extensionUri: { fsPath: EXT_ROOT, scheme: 'file' },
        globalStorageUri: { fsPath: storage, scheme: 'file' },
        storageUri: { fsPath: storage, scheme: 'file' },
        logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage,
        storagePath: storage,
        logPath: storage,
        globalState: memento(),
        workspaceState: memento(),
        asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    } as never;
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
    ProcessStateStore.init(context);
    SessionTodoStore.init(context);
    TrailService.init(context);
    ReminderSystem.init(context);
    TimerEngine.init(context);
    PromptQueueManager.init(context);
}
function stopStores(): void {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
}

test('MA-0: without a running queue, removing an item is an error', async () => {
    const tool = ALL_SHARED_TOOLS.find((t) => t.name === 'tomAi_removeQueueItem')!;
    const answer = JSON.parse(String(await tool.execute({ queueItemId: 'q-1' } as never)));
    assert.equal(answer.ok, false);
    assert.match(answer.error, /not initialised/);
});

describe('every tool over MCP, in a sandbox', () => {
    let client: Client;
    let listed: Array<{ name: string; inputSchema: Json }>;
    const outcomes: Outcome[] = [];
    const repoBefore = gitStatus(EXT_ROOT);
    const headBefore = git(EXT_ROOT, 'rev-parse', 'HEAD');
    const answerOf = (tool: string): string => outcomes.find((o) => o.tool === tool)?.text ?? '';

    before(async () => {
        recordWrites();
        startStores();
        const tools = resolveEffectiveMcpTools(settings, env[KEY_ENV], env);
        const { server } = buildToolMcpServer(tools, NULL_MCP_TRAIL_SINK);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        client = new Client({ name: 'mcp-all-tools-test', version: '1.0.0' });
        await client.connect(clientTransport);
        listed = (await client.listTools()).tools as Array<{ name: string; inputSchema: Json }>;
    });

    after(async () => {
        await client?.close();
        stopStores();
        if (process.env.MCP_ALL_TOOLS_REPORT) {
            for (const o of outcomes) {
                process.stdout.write(`${o.ok ? 'ok ' : 'ERR'} ${String(o.ms).padStart(5)} ms  ${o.tool}  ${o.text.replace(/\s+/g, ' ').slice(0, 160)}\n`);
            }
        }
    });

    test('MA-1: every registered tool is listed, with resources and prompts', async () => {
        const names = new Set(listed.map((t) => t.name));
        const missing = ALL_SHARED_TOOLS.map((t) => t.name).filter((n) => !names.has(n));
        assert.deepEqual(missing, [], 'registered but not served');
        assert.equal(names.size, ALL_SHARED_TOOLS.length);
        const resources = await client.listResources();
        assert.ok(resources.resources.length > 0, 'resources');
        const prompts = await client.listPrompts();
        assert.ok(prompts.prompts.length > 0, 'prompts');
    });

    test('MA-2: every registered tool answers', async () => {
        const given = inputs();
        const unknown = Object.keys(given).filter((n) => !listed.some((t) => t.name === n));
        assert.deepEqual(unknown, [], 'inputs for tools that are not registered');
        const hung: string[] = [];
        const prev: Record<string, Json> = {};
        // A tool that removes what another one created runs after everything else.
        const last = (n: string): boolean => /^tomAi_(remove|delete)[A-Z]/.test(n) || n === 'tomAi_killCommand';
        // The queue item is staged before anything edits it: only a staged item is editable, and
        // addQueueItem answers `pending` even when deferSend is set (vsd6).
        const first = ['tomAi_addQueueItem', 'tomAi_setQueueItemStatus'];
        const rank = (n: string): number => first.includes(n) ? first.indexOf(n) - first.length
            : n === 'tomAi_removeQueueItem' ? 2 : last(n) ? 1 : 0;
        const order = listed.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.name) - rank(b.t.name) || a.i - b.i).map((x) => x.t);
        for (const tool of order) {
            const input = given[tool.name];
            const args = typeof input === 'function' ? input(prev) : input ?? fromSchema(tool.inputSchema);
            const start = Date.now();
            try {
                const call = client.callTool({ name: tool.name, arguments: args });
                if (ANSWERS[tool.name]) { await answerWhenAsked(ANSWERS[tool.name].answer); }
                const r = await withTimeout(call, CALL_TIMEOUT_MS, tool.name);
                const content = r.content as Array<{ type: string; text?: string }>;
                const text = content?.[0]?.text ?? '';
                try { prev[tool.name] = JSON.parse(text); } catch { prev[tool.name] = text; }
                outcomes.push({ tool: tool.name, ok: !r.isError, ms: Date.now() - start, text });
            } catch (err) {
                hung.push(`${tool.name}: ${(err as Error).message}`);
                outcomes.push({ tool: tool.name, ok: false, ms: Date.now() - start, text: `THREW ${(err as Error).message}` });
            }
        }
        assert.deepEqual(hung, [], 'a call that hung or failed at the protocol level');
        assert.equal(outcomes.length, ALL_SHARED_TOOLS.length);
    });

    test('MA-3: every write landed in the sandbox, nothing outside changed, nothing left the machine', () => {
        assert.ok(outcomes.length > 0, 'MA-2 ran first');
        const outside = [...new Set(writes)].filter((w) => w !== SANDBOX && !w.startsWith(SANDBOX + path.sep));
        assert.deepEqual(outside, [], 'written outside the sandbox');
        assert.ok(writes.some((w) => w.startsWith(WS + path.sep)), 'the write tools did write (into the sandbox)');
        assert.equal(gitStatus(EXT_ROOT), repoBefore, "the extension's repository is as it was");
        assert.equal(git(EXT_ROOT, 'rev-parse', 'HEAD'), headBefore, "and has no new commit (gitWrite committed in the sandbox's)");
        assert.equal(os.homedir(), HOME, 'HOME is the sandbox home while the tools run');
        assert.notEqual(HOME, REAL_HOME);
        assert.ok(refusedRequests.length >= 2, `the web tools tried to go out and were refused: ${refusedRequests.join(', ')}`);
        // What the write tools wrote is there, in the sandbox.
        assert.equal(fs.readFileSync(path.join(WS, 'created/applied.md'), 'utf8'), 'applied\n', 'tomAi_applyEdit');
        assert.match(fs.readFileSync(path.join(WS, 'notes/plain.md'), 'utf8'), /ALPHA beta GAMMA/, 'tomAi_editFile + tomAi_multiEditFile');
        assert.ok(!fs.existsSync(path.join(WS, 'created/moved.md')), 'tomAi_moveFile then tomAi_deleteFile');
        assert.match(git(WS, 'log', '--format=%s'), /^written by the MCP test\nfixture$/, "tomAi_gitWrite's commit, in the sandbox repository");
        assert.match(fs.readFileSync(path.join(WS, 'notes/doc.md'), 'utf8'), /delta, written by the MCP test/, 'tomAi_docspecsReplaceSection');
        assert.match(fs.readFileSync(path.join(WS, `_ai/quests/${QUEST}/process-state.${QUEST}.yaml`), 'utf8'), /process: flow/, 'tomAi_setProcessState');
        assert.ok(fs.existsSync(path.join(WS, 'specs/generated-doc/codespecs_extracts/gate.verdicts.yaml')), 'tomAi_specCodeSpecsSetVerdict');
    });

    test('MA-4: the right answers', () => {
        assert.match(answerOf('tomAi_readFile'), /# Demo workspace/);
        assert.match(answerOf('tomAi_findTextInFiles'), /notes\/plain\.md:3:alpha/);
        assert.match(answerOf('tomAi_gitRead'), /fixture/);
        assert.match(answerOf('tomAi_runCommand'), /sandbox/);
        assert.match(answerOf('tomAi_askUser'), ANSWERS.tomAi_askUser.expect, 'the ask returns what the user typed');
        assert.match(answerOf('tomAi_askUserPicker'), ANSWERS.tomAi_askUserPicker.expect, 'the picker returns the item picked');
        assert.match(answerOf('tomAi_listQuestTodos'), /demo1_aaaa-first/);
        assert.match(answerOf('tomAi_getProcess'), /"id": "flow"/);
        // The queue tools worked on one item, which the last of them removed.
        assert.match(answerOf('tomAi_updateQueueFollowUp'), /"ok": ?true/);
        assert.match(answerOf('tomAi_removeQueueItem'), /"ok": ?true/);
        assert.equal(PromptQueueManager.instance.items.length, 0, 'the queue is empty again');
        // A spec edit is read back from the file.
        assert.match(fs.readFileSync(path.join(WS, SPEC), 'utf8'), /Written by the MCP test\./, 'tomAi_specSetContent');
        assert.match(answerOf('tomAi_specValidate'), /"ok": ?true/);
    });
});
