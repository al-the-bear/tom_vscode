/**
 * The Role Editor (vscimpb87, gsel7): one page (`media/rolesEditor/`) with a
 * **Roles** tab and a **Role Types** tab (design
 * role_and_guideline_selector.vscode_extension.md AS-1, L-6).
 *
 *  - **Roles** (`tomAi.editor.roles` opens the page on it): every role of
 *    `_ai/roles/` — its role.md, the role type its role-config.yaml names
 *    (none: the profile's tools) and its guideline choices.
 *  - **Role Types** (`tomAi.editor.roleTypes` opens the page on it): every
 *    role type of `_ai/role-types/` — name, description, its tools (the
 *    profile's default, or a selection; the always-on tools shown greyed and
 *    on) and its guideline choices.
 *
 * Each role and role type has the guideline picker (media/shared/aspectPicker.js)
 * for its choices, saved with the item (default: none, *Don't add* for every
 * section). Every message of the page names its tab (`kind`).
 *
 * The files are written by `services/roleStore.ts`, which checks each against
 * its JSON schema.
 */

import { inStoredOrder, moveInStoredOrder } from '../services/editorListOrder';
import { moveDirection } from '../utils/listOrder';
import * as vscode from 'vscode';
import * as path from 'path';
import { RoleStore } from '../services/roleStore';
import { WsPaths } from '../utils/workspacePaths';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { AVAILABLE_LLM_TOOLS } from '../utils/constants';
import { categorizeTools } from '../utils/toolCategories';
import { ALWAYS_ON_TOOLS, ROLE_ID_PATTERN, type RoleType } from '../utils/roleTypes';
import { aspectCatalogueOf, normalizeAspectChoices, type AspectCatalogue } from '../utils/aspectChoices';
import { ASPECT_SECTION_EDITOR_COMMAND } from './aspectSectionEditor-handler';

export type RolesEditorKind = 'roles' | 'roleTypes';

const VIEW_TYPE = 'tomAi.rolesEditor';
const TITLE = 'Role Editor';
const TAB_NAMES: Record<RolesEditorKind, string> = { roles: 'Role', roleTypes: 'Role type' };
let panel: vscode.WebviewPanel | undefined;

/** What the page needs besides the role store: the guideline aspects, and what to do after a save. */
export interface RolesEditorEnv {
    /** The guideline aspects the picker offers. */
    aspects?: () => AspectCatalogue;
    /** A role's or role type's choices changed: the other pickers show the roles' levels. */
    changed?: () => void;
}

function store(): RoleStore | undefined {
    const topTom = WsPaths.topTom;
    const roles = WsPaths.ai('roles');
    return topTom && roles ? new RoleStore(topTom, path.dirname(roles)) : undefined;
}

/** The tab a message names (`kind`); Roles when it names none. */
export function rolesEditorKindOf(value: unknown): RolesEditorKind {
    return value === 'roleTypes' ? 'roleTypes' : 'roles';
}

/**
 * What the page shows on tab `kind`: its items, for roles the role types to
 * pick (with their choices: the level above a role's), for role types the
 * tools to select; and the guideline aspects.
 */
export function rolesEditorData(kind: RolesEditorKind, s: RoleStore | undefined, env?: RolesEditorEnv): Record<string, unknown> {
    let aspects: AspectCatalogue = { sections: [] };
    try { aspects = env?.aspects?.() ?? aspects; } catch { /* the picker opens without sections */ }
    if (!s) { return { type: 'data', kind, error: 'No workspace is open.', items: [], aspects }; }
    // Each list in the order the Up / Down buttons gave it (list keys `roles`, `roleTypes`); an entry not placed yet follows.
    const roleTypes = inStoredOrder('roleTypes', s.roleTypes(), (t) => t.id);
    if (kind === 'roles') {
        return {
            type: 'data', kind, aspects,
            items: inStoredOrder('roles', s.roles(), (r) => r.id),
            roleTypes: roleTypes.map((t) => ({ id: t.id, name: t.value?.name ?? t.id, ...(t.value?.guidelines ? { guidelines: t.value.guidelines } : {}) })),
        };
    }
    return {
        type: 'data', kind, aspects, items: roleTypes,
        toolGroups: categorizeTools(AVAILABLE_LLM_TOOLS).map((g) => ({ category: g.category, tools: g.tools.map((o) => o.value) })),
        alwaysOn: [...ALWAYS_ON_TOOLS],
    };
}

/** The choices a save carries: `{}` (none) when the page sent none or nothing usable. */
function choicesOf(value: unknown): Record<string, string | string[]> {
    return normalizeAspectChoices(value) ?? {};
}

/** A message from the page on tab `kind`; answers what to post back (undefined: nothing). */
export async function handleRolesEditorMessage(
    kind: RolesEditorKind,
    msg: Record<string, unknown>,
    s: RoleStore | undefined,
    ui: { ask(prompt: string): Promise<string | undefined>; confirm(message: string): Promise<boolean>; error(message: string): void; info(message: string): void },
    env?: RolesEditorEnv,
): Promise<Record<string, unknown> | undefined> {
    const data = (selected?: string) => ({ ...rolesEditorData(kind, s, env), ...(selected ? { selected } : {}) });
    if (msg.type === 'ready' || msg.type === 'refresh') { return data(typeof msg.selected === 'string' ? msg.selected : undefined); }
    if (!s) { ui.error('No workspace is open.'); return undefined; }
    const id = String(msg.id ?? '');
    try {
        switch (msg.type) {
            case 'save':
                if (kind === 'roles') {
                    s.saveRole(id, String(msg.roleMd ?? ''), typeof msg.roleType === 'string' ? msg.roleType : undefined, choicesOf(msg.guidelines));
                } else {
                    const value = { ...(msg.value as RoleType) };
                    value.guidelines = choicesOf((msg.value as { guidelines?: unknown } | undefined)?.guidelines);
                    s.saveRoleType(id, value);
                }
                env?.changed?.();
                ui.info(`${TAB_NAMES[kind]} ${id} saved.`);
                return data(id);
            case 'add': {
                const name = (await ui.ask(kind === 'roles' ? 'Name of the new role (folder under _ai/roles/)' : 'Name of the new role type (folder under _ai/role-types/)'))?.trim();
                if (!name) { return undefined; }
                if (!ROLE_ID_PATTERN.test(name)) { ui.error(`"${name}" is not a valid name: letters, digits, _ and -, starting with a letter or digit.`); return undefined; }
                if (kind === 'roles') { s.createRole(name); } else { s.createRoleType(name); }
                return data(name);
            }
            case 'move': {
                // Up / Down: the entry moves one place in the list; the order is stored, the folders are not touched.
                const direction = moveDirection(msg.direction);
                const shown = ((rolesEditorData(kind, s).items ?? []) as Array<{ id: string }>).map((i) => i.id);
                if (!direction || !moveInStoredOrder(kind, shown, id, direction)) { return undefined; }
                return { type: 'order', kind, ids: ((rolesEditorData(kind, s).items ?? []) as Array<{ id: string }>).map((i) => i.id) };
            }
            case 'delete':
                if (kind !== 'roleTypes') { return undefined; }
                if (!await ui.confirm(`Delete role type ${id}?`)) { return undefined; }
                s.deleteRoleType(id);
                env?.changed?.();
                return data();
            default:
                return undefined;
        }
    } catch (e) {
        ui.error((e as Error).message);
        return undefined;
    }
}

/** The live sections and the refresh of the other pickers. */
function liveEnv(): RolesEditorEnv {
    return {
        aspects: () => {
            /* eslint-disable @typescript-eslint/no-require-imports */
            const { readPickerSections } = require('../services/aspectPickerState') as typeof import('../services/aspectPickerState');
            /* eslint-enable @typescript-eslint/no-require-imports */
            const read = readPickerSections();
            return { ...aspectCatalogueOf(read.sections), ...(read.problems.length ? { problems: read.problems } : {}) };
        },
        changed: () => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                (require('./aspectViewsRefresh') as typeof import('./aspectViewsRefresh')).refreshAspectViews();
            } catch { /* nothing open to refresh */ }
        },
    };
}

/** The page posted to: the data of the tab it shows now (the sections changed, or the files). */
export function refreshRolesEditor(): void {
    if (panel) { void panel.webview.postMessage({ type: 'reload' }); }
}

/** Open (or reveal) the Role Editor on tab `kind`, `selected` chosen. */
export function openRolesEditor(context: vscode.ExtensionContext, kind: RolesEditorKind, selected?: string): void {
    if (panel) {
        panel.reveal();
        void panel.webview.postMessage({ type: 'showTab', kind, ...(selected ? { selected } : {}) });
        return;
    }
    const created = vscode.window.createWebviewPanel(VIEW_TYPE, TITLE, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
    });
    bindRolesEditorPanel(context, created, kind, selected);
}

function bindRolesEditorPanel(context: vscode.ExtensionContext, bound: vscode.WebviewPanel, kind: RolesEditorKind, selected?: string): void {
    panel = bound;
    bound.title = TITLE;
    const codiconsUri = bound.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')).toString();
    const ui = {
        ask: (prompt: string) => Promise.resolve(vscode.window.showInputBox({ prompt })),
        confirm: async (message: string) => (await vscode.window.showWarningMessage(message, { modal: true }, 'Delete')) === 'Delete',
        error: (message: string) => { void vscode.window.showErrorMessage(`${TITLE}: ${message}`); },
        info: (message: string) => { vscode.window.setStatusBarMessage(`$(check) ${message}`, 3000); },
    };
    const env = liveEnv();
    bound.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
        if (msg.type === 'aspectEditSections') {
            await vscode.commands.executeCommand(ASPECT_SECTION_EDITOR_COMMAND);
            return;
        }
        const answer = await handleRolesEditorMessage(rolesEditorKindOf(msg.kind), msg, store(), ui, env);
        if (answer) { void bound.webview.postMessage(answer); }
    }, undefined, context.subscriptions);
    bound.onDidDispose(() => { if (panel === bound) { panel = undefined; } }, undefined, context.subscriptions);
    bound.webview.html = loadWebviewHtml(bound.webview, 'rolesEditor', { init: { codiconsUri, kind, title: TITLE, ...(selected ? { selected } : {}) } });
}

/** The two commands (each opens the one page on its tab) and the reload serializer. */
export function registerRolesEditorCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tomAi.editor.roles', (args?: { role?: string }) => openRolesEditor(context, 'roles', args?.role)),
        vscode.commands.registerCommand('tomAi.editor.roleTypes', (args?: { roleType?: string }) => openRolesEditor(context, 'roleTypes', args?.roleType)),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(restored: vscode.WebviewPanel, state: unknown) {
                if (panel) { restored.dispose(); return; }
                restored.webview.options = {
                    enableScripts: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(context.extensionUri, 'media'),
                        vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                    ],
                };
                bindRolesEditorPanel(context, restored, rolesEditorKindOf((state as { kind?: string } | undefined)?.kind));
            },
        }),
    );
}
