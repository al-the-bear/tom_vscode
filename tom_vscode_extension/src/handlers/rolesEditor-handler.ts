/**
 * The Role Editor and the Role Type Editor (vscimpb87): one webview
 * (`media/rolesEditor/`) in two modes.
 *
 *  - **Role Editor** (`tomAi.editor.roles`): every role of `_ai/roles/` — its
 *    role.md and the role type its role-config.yaml names (none: the
 *    profile's tools).
 *  - **Role Type Editor** (`tomAi.editor.roleTypes`): every role type of
 *    `_ai/role-types/` — name, description and its tools: the profile's
 *    default, or a selection (the always-on tools shown greyed and on).
 *
 * The files are written by `services/roleStore.ts`, which checks each against
 * its JSON schema.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { RoleStore } from '../services/roleStore';
import { WsPaths } from '../utils/workspacePaths';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { AVAILABLE_LLM_TOOLS } from '../utils/constants';
import { categorizeTools } from '../utils/toolCategories';
import { ALWAYS_ON_TOOLS, ROLE_ID_PATTERN, type RoleType } from '../utils/roleTypes';

export type RolesEditorKind = 'roles' | 'roleTypes';

const VIEW_TYPE = 'tomAi.rolesEditor';
const TITLES: Record<RolesEditorKind, string> = { roles: 'Role Editor', roleTypes: 'Role Type Editor' };
const panels = new Map<RolesEditorKind, vscode.WebviewPanel>();

function store(): RoleStore | undefined {
    const ws = WsPaths.wsRoot;
    const roles = WsPaths.ai('roles');
    return ws && roles ? new RoleStore(ws, path.dirname(roles)) : undefined;
}

/** What the webview shows: the items of its kind, the role types to pick, the tools to select. */
export function rolesEditorData(kind: RolesEditorKind, s: RoleStore | undefined): Record<string, unknown> {
    if (!s) { return { type: 'data', kind, error: 'No workspace is open.', items: [] }; }
    const roleTypes = s.roleTypes();
    if (kind === 'roles') {
        return { type: 'data', kind, items: s.roles(), roleTypes: roleTypes.map((t) => ({ id: t.id, name: t.value?.name ?? t.id })) };
    }
    return {
        type: 'data', kind, items: roleTypes,
        toolGroups: categorizeTools(AVAILABLE_LLM_TOOLS).map((g) => ({ category: g.category, tools: g.tools.map((o) => o.value) })),
        alwaysOn: [...ALWAYS_ON_TOOLS],
    };
}

/** A message from the webview; answers what to post back (undefined: nothing). */
export async function handleRolesEditorMessage(
    kind: RolesEditorKind,
    msg: Record<string, unknown>,
    s: RoleStore | undefined,
    ui: { ask(prompt: string): Promise<string | undefined>; confirm(message: string): Promise<boolean>; error(message: string): void; info(message: string): void },
): Promise<Record<string, unknown> | undefined> {
    const data = (selected?: string) => ({ ...rolesEditorData(kind, s), ...(selected ? { selected } : {}) });
    if (msg.type === 'ready' || msg.type === 'refresh') { return data(typeof msg.selected === 'string' ? msg.selected : undefined); }
    if (!s) { ui.error('No workspace is open.'); return undefined; }
    const id = String(msg.id ?? '');
    try {
        switch (msg.type) {
            case 'save':
                if (kind === 'roles') {
                    s.saveRole(id, String(msg.roleMd ?? ''), typeof msg.roleType === 'string' ? msg.roleType : undefined);
                } else {
                    s.saveRoleType(id, msg.value as RoleType);
                }
                ui.info(`${kind === 'roles' ? 'Role' : 'Role type'} ${id} saved.`);
                return data(id);
            case 'add': {
                const name = (await ui.ask(kind === 'roles' ? 'Name of the new role (folder under _ai/roles/)' : 'Name of the new role type (folder under _ai/role-types/)'))?.trim();
                if (!name) { return undefined; }
                if (!ROLE_ID_PATTERN.test(name)) { ui.error(`"${name}" is not a valid name: letters, digits, _ and -, starting with a letter or digit.`); return undefined; }
                if (kind === 'roles') { s.createRole(name); } else { s.createRoleType(name); }
                return data(name);
            }
            case 'delete':
                if (kind !== 'roleTypes') { return undefined; }
                if (!await ui.confirm(`Delete role type ${id}?`)) { return undefined; }
                s.deleteRoleType(id);
                return data();
            default:
                return undefined;
        }
    } catch (e) {
        ui.error((e as Error).message);
        return undefined;
    }
}

/** Open (or reveal) the editor of `kind`, `selected` chosen. */
export function openRolesEditor(context: vscode.ExtensionContext, kind: RolesEditorKind, selected?: string): void {
    const existing = panels.get(kind);
    if (existing) {
        existing.reveal();
        if (selected) { void existing.webview.postMessage({ ...rolesEditorData(kind, store()), selected }); }
        return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, TITLES[kind], vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
    });
    bindRolesEditorPanel(context, panel, kind, selected);
}

function bindRolesEditorPanel(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, kind: RolesEditorKind, selected?: string): void {
    panels.set(kind, panel);
    const codiconsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')).toString();
    const ui = {
        ask: (prompt: string) => Promise.resolve(vscode.window.showInputBox({ prompt })),
        confirm: async (message: string) => (await vscode.window.showWarningMessage(message, { modal: true }, 'Delete')) === 'Delete',
        error: (message: string) => { void vscode.window.showErrorMessage(`${TITLES[kind]}: ${message}`); },
        info: (message: string) => { vscode.window.setStatusBarMessage(`$(check) ${message}`, 3000); },
    };
    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
        const answer = await handleRolesEditorMessage(kind, msg.type === 'ready' && selected ? { ...msg, selected } : msg, store(), ui);
        if (answer) { void panel.webview.postMessage(answer); }
    }, undefined, context.subscriptions);
    panel.onDidDispose(() => { if (panels.get(kind) === panel) { panels.delete(kind); } }, undefined, context.subscriptions);
    panel.webview.html = loadWebviewHtml(panel.webview, 'rolesEditor', { init: { codiconsUri, kind, title: TITLES[kind] } });
}

/** The two commands and the reload serializer. */
export function registerRolesEditorCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.roles', (args?: { role?: string }) => openRolesEditor(context, 'roles', args?.role)),
        vscode.commands.registerCommand('tomAi.editor.roleTypes', (args?: { roleType?: string }) => openRolesEditor(context, 'roleTypes', args?.roleType)),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
                const kind: RolesEditorKind = (state as { kind?: string } | undefined)?.kind === 'roleTypes' ? 'roleTypes' : 'roles';
                panel.webview.options = {
                    enableScripts: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(context.extensionUri, 'media'),
                        vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                    ],
                };
                bindRolesEditorPanel(context, panel, kind);
            },
        }),
    );
}
