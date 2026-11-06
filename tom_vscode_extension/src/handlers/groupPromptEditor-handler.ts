/**
 * Group prompt editor — the prompts a todo-group walk sends for each todo
 * (`src/utils/groupPrompts.ts`): the global default and additions, and one
 * quest's default override, additions and own prompts. The todo panel's
 * "Queue Group Prompt" picker offers them.
 *
 * The page keeps the edited texts until Save (every changed entry at once) or
 * Revert. New entries are named here (an input box) and written at once;
 * deleting asks first. The preview shows what a walk sends with the selected
 * entry, the unsaved texts included.
 *
 * Command: `tomAi.editor.groupPrompts` (optional argument: the quest).
 * Assets: `media/groupPromptEditor/`.
 */

import * as vscode from 'vscode';

import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { listQuestIds } from '../managers/questTodoManager.js';
import { groupPromptDirs } from '../services/groupPromptDirs';
import { deleteGroupPrompt, readGroupPrompts, writeGroupPrompt } from '../services/groupPromptStore';
import {
    BUILTIN_GROUP_PROMPT,
    GROUP_PROMPT_KINDS,
    groupPromptKey,
    groupPromptNameError,
    groupPromptPreview,
    type GroupPromptEntry,
    type GroupPromptKind,
    type GroupPromptScope,
} from '../utils/groupPrompts';
import { loadWebviewHtml } from '../utils/webviewLoader';

const VIEW_TYPE = 'tomAi.groupPromptEditor';

let panel: vscode.WebviewPanel | undefined;
let questId = '';
let selectedKey = 'global:default:';

/** The placeholders a group prompt usually needs. */
const VARIABLES: ReadonlyArray<{ name: string; description: string }> = [
    { name: 'repeatTodoId', description: 'The id of the todo this send works on' },
    { name: 'repeatTodoTitle', description: 'Its title' },
    { name: 'repeatNumber', description: 'Which send of the walk this is (1, 2, …)' },
    { name: 'quest', description: "The window's quest" },
    { name: 'role', description: 'The active role' },
    { name: 'date', description: 'Today' },
];

/** An entry as the page lists it; a global default without a file is the built-in one. */
interface PageEntry extends GroupPromptEntry {
    key: string;
    exists: boolean;
}

function webviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
    return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
}

function windowQuest(): string {
    try { return ChatVariablesStore.instance.quest || ''; } catch { return ''; }
}

/** Open the editor on `quest` (default: the window's quest). */
export function openGroupPromptEditor(context: vscode.ExtensionContext, quest?: string): void {
    questId = quest || questId || windowQuest();
    if (panel) {
        panel.reveal();
        sendAll();
        return;
    }
    bind(context, vscode.window.createWebviewPanel(VIEW_TYPE, 'Group Prompts', vscode.ViewColumn.Active, {
        ...webviewOptions(context),
        retainContextWhenHidden: true,
    }));
}

function bind(context: vscode.ExtensionContext, p: vscode.WebviewPanel): void {
    panel = p;
    if (!questId) { questId = windowQuest(); }
    p.webview.html = loadWebviewHtml(p.webview, 'groupPromptEditor', {});
    p.webview.onDidReceiveMessage((msg) => void handle(msg), undefined, context.subscriptions);
    p.onDidDispose(() => { panel = undefined; });
}

function pageEntries(): PageEntry[] {
    const dirs = groupPromptDirs(questId || undefined);
    const read = dirs ? readGroupPrompts(dirs) : [];
    const entries: PageEntry[] = read.map((e) => ({ ...e, key: groupPromptKey(e), exists: true }));
    if (!read.some((e) => e.scope === 'global' && e.kind === 'default')) {
        entries.unshift({ scope: 'global', kind: 'default', name: '', text: BUILTIN_GROUP_PROMPT, key: groupPromptKey({ scope: 'global', kind: 'default', name: '' }), exists: false });
    }
    return entries;
}

function sendAll(): void {
    if (!panel) { return; }
    let quests: string[] = [];
    try { quests = listQuestIds(); } catch { quests = []; }
    const entries = pageEntries();
    if (!entries.some((e) => e.key === selectedKey)) { selectedKey = entries[0].key; }
    void panel.webview.postMessage({ type: 'load', questId, quests, entries, selected: selectedKey, builtinDefault: BUILTIN_GROUP_PROMPT, variables: VARIABLES });
}

/** Ask for the name of a new addition or prompt; undefined when cancelled. */
async function askName(scope: GroupPromptScope, kind: GroupPromptKind, taken: Set<string>): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({
        title: `New ${scope === 'global' ? 'global' : questId} ${kind}`,
        prompt: kind === 'prompt' ? 'The name the picker shows for this prompt' : 'The name the picker shows as "Default + <name>"',
        validateInput: (value) => groupPromptNameError(value.trim()) ?? (taken.has(value.trim()) ? 'That name is taken.' : undefined),
    });
    return name?.trim() || undefined;
}

async function create(scope: GroupPromptScope, kind: GroupPromptKind): Promise<void> {
    const dirs = groupPromptDirs(questId || undefined);
    if (!dirs || (scope === 'quest' && !dirs.quest) || !GROUP_PROMPT_KINDS[scope].includes(kind)) { return; }
    const entries = pageEntries();
    let name = '';
    let text = '';
    if (kind === 'default') {
        // A quest's own default starts from the global one.
        text = entries.find((e) => e.scope === 'global' && e.kind === 'default')?.text ?? BUILTIN_GROUP_PROMPT;
    } else {
        const taken = new Set(entries.filter((e) => e.scope === scope && e.kind === kind).map((e) => e.name));
        const asked = await askName(scope, kind, taken);
        if (!asked) { return; }
        name = asked;
    }
    writeGroupPrompt(dirs, { scope, kind, name, text });
    selectedKey = groupPromptKey({ scope, kind, name });
    sendAll();
}

async function remove(scope: GroupPromptScope, kind: GroupPromptKind, name: string): Promise<void> {
    const dirs = groupPromptDirs(questId || undefined);
    if (!dirs) { return; }
    const what = kind === 'default'
        ? (scope === 'global' ? 'the global default (the built-in default is used again)' : `${questId}'s own default (the global default is used again)`)
        : `the ${scope === 'global' ? 'global' : questId} ${kind} "${name}"`;
    const answer = await vscode.window.showWarningMessage(`Delete ${what}?`, { modal: true }, 'Delete');
    if (answer !== 'Delete') { return; }
    deleteGroupPrompt(dirs, scope, kind, name);
    sendAll();
}

function save(edited: GroupPromptEntry[]): void {
    const dirs = groupPromptDirs(questId || undefined);
    if (!dirs) { return; }
    try {
        for (const entry of edited) { writeGroupPrompt(dirs, entry); }
        void panel?.webview.postMessage({ type: 'saved' });
    } catch (e) {
        void vscode.window.showErrorMessage(`Group prompts: ${(e as Error).message}`);
    }
    sendAll();
}

interface Message {
    type: string;
    scope?: GroupPromptScope;
    kind?: GroupPromptKind;
    name?: string;
    key?: string;
    questId?: string;
    entries?: GroupPromptEntry[];
}

async function handle(msg: Message): Promise<void> {
    switch (msg.type) {
        case 'ready':
        case 'revert':
            sendAll();
            break;
        case 'select':
            if (msg.key) { selectedKey = msg.key; }
            break;
        case 'quest':
            questId = msg.questId || '';
            sendAll();
            break;
        case 'preview':
            if (msg.key && msg.entries) {
                const preview = groupPromptPreview(msg.entries, msg.key);
                void panel?.webview.postMessage({ type: 'preview', key: msg.key, text: preview?.text ?? '', note: preview?.note ?? '' });
            }
            break;
        case 'create':
            if (msg.scope && msg.kind) { await create(msg.scope, msg.kind); }
            break;
        case 'delete':
            if (msg.scope && msg.kind) { await remove(msg.scope, msg.kind, msg.name ?? ''); }
            break;
        case 'save':
            if (msg.entries) { save(msg.entries); }
            break;
    }
}

/** Register `tomAi.editor.groupPrompts` and restore the panel after a window reload. */
export function registerGroupPromptEditor(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.groupPrompts', (quest?: unknown) =>
            openGroupPromptEditor(context, typeof quest === 'string' ? quest : undefined)),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(p: vscode.WebviewPanel): Promise<void> {
                if (panel) { p.dispose(); return; }
                p.webview.options = webviewOptions(context);
                bind(context, p);
            },
        }),
    );
}
