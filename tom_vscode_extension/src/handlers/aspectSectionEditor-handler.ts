/**
 * The guideline section editor (gsel7; design
 * role_and_guideline_selector.vscode_extension.md P-4): a page
 * (`media/aspectSectionEditor/`, `tomAi.editor.aspectSections`) editing the
 * aspect sections of `_ai/aspect_guidelines/` and their options.
 *
 * - Per section: its name, short label, placement (system or user prompt),
 *   default option and the order of its options; per option its short name
 *   and its text (Markdown, placeholders resolved when sent). The page edits a
 *   section as a draft and Save writes it as a whole
 *   (services/aspectSectionsEdit.ts saveAspectSection): adding, renaming and
 *   deleting an option happen in the draft.
 * - Sections are added, renamed (the folder: the id the levels' choices name)
 *   and deleted at once, through the list's buttons.
 * - A rename keeps the choices in effect (gsel7b): a section renamed, or an
 *   option renamed in the draft (the page sends `renames`, old name → new name,
 *   with the save), rewrites every stored choice that names the old one
 *   (aspectChoiceCommands.ts carryAspectChoicesOver), and the page and a
 *   VS Code message say what was rewritten.
 *
 * Opened from *Edit sections…* in every guideline picker and from Extension
 * Tools (utils/extensionToolsCatalog.ts). After every write the pickers are
 * redrawn (aspectViewsRefresh.ts) and the Role Editor reads the sections
 * again.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { ASPECT_GUIDELINES_FOLDER } from '../services/aspectGuidelinesStore';
import {
    createAspectSection,
    deleteAspectSection,
    readSectionsForEdit,
    renameAspectSection,
    saveAspectSection,
    type AspectSectionEdit,
} from '../services/aspectSectionsEdit';
import { isAspectName } from '../utils/aspectGuidelines';
import { parseAspectRename, type AspectRename } from '../utils/aspectRename';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { WsPaths } from '../utils/workspacePaths';

/** The command of the section editor page (P-4). */
export const ASPECT_SECTION_EDITOR_COMMAND = 'tomAi.editor.aspectSections';

const VIEW_TYPE = 'tomAi.aspectSectionEditor';
const TITLE = 'Guideline Sections';
let panel: vscode.WebviewPanel | undefined;

/** Where the sections are and what follows a write. */
export interface AspectSectionEditorEnv {
    /** `_ai/aspect_guidelines/`; undefined without an `_ai` folder. */
    dir: string | undefined;
    /** The top `.tom`, for the schema line of `section.yaml`. */
    topTom?: string;
    /** A section changed: the pickers and the Role Editor read the sections again. */
    changed?: () => void;
    /** A section or options renamed: carry the stored choices over; answers what was rewritten. */
    renamed?: (rename: AspectRename) => string | undefined;
}

/** What the page asks the user and shows. */
export interface AspectSectionEditorUi {
    ask(prompt: string, value?: string): Promise<string | undefined>;
    confirm(message: string, action: string): Promise<boolean>;
    error(message: string): void;
    info(message: string): void;
    /** A message the user should read (what a rename rewrote). */
    notice?(message: string): void;
    reveal?(file: string): void;
}

/** What the page shows: every section as it is on disk. */
export function aspectSectionEditorData(env: AspectSectionEditorEnv, selected?: string): Record<string, unknown> {
    if (!env.dir) { return { type: 'data', error: 'This workspace has no _ai folder: there are no guideline sections.', sections: [] }; }
    return { type: 'data', sections: readSectionsForEdit(env.dir), ...(selected ? { selected } : {}) };
}

/** The section a save carries, as the store takes it; undefined when it is none. */
function sectionOf(value: unknown): Omit<AspectSectionEdit, 'problems'> | undefined {
    if (typeof value !== 'object' || value === null) { return undefined; }
    const v = value as Record<string, unknown>;
    if (typeof v.id !== 'string') { return undefined; }
    const options = Array.isArray(v.options) ? v.options : [];
    return {
        id: v.id,
        name: typeof v.name === 'string' ? v.name : '',
        label: typeof v.label === 'string' ? v.label : '',
        placement: v.placement === 'user' ? 'user' : v.placement === 'system' || v.placement === undefined ? 'system' : (v.placement as 'system'),
        defaultOption: typeof v.defaultOption === 'string' ? v.defaultOption : '',
        options: options.map((o) => {
            const r = (typeof o === 'object' && o !== null ? o : {}) as Record<string, unknown>;
            return { name: typeof r.name === 'string' ? r.name.trim() : '', text: typeof r.text === 'string' ? r.text : '' };
        }),
    };
}

const NAME_RULE = 'not empty, no "/" or "\\", no line break, no space at either end';

/** The option renames a save carries, kept to those whose new name is an option of the saved section. */
function optionRenamesOf(value: unknown, section: Omit<AspectSectionEdit, 'problems'>): AspectRename | undefined {
    const rename = parseAspectRename({ kind: 'options', section: section.id, options: value });
    if (!rename || rename.kind !== 'options') { return undefined; }
    const names = new Set(section.options.map((o) => o.name));
    return parseAspectRename({ kind: 'options', section: section.id, options: Object.fromEntries(Object.entries(rename.options).filter(([, to]) => names.has(to))) });
}

/** A message from the page; answers what to post back (undefined: nothing). */
export async function handleAspectSectionEditorMessage(
    msg: Record<string, unknown>,
    env: AspectSectionEditorEnv,
    ui: AspectSectionEditorUi,
): Promise<Record<string, unknown> | undefined> {
    const data = (selected?: string, extra?: Record<string, unknown>) => ({ ...aspectSectionEditorData(env, selected), ...(extra ?? {}) });
    if (msg.type === 'ready' || msg.type === 'refresh') { return data(typeof msg.selected === 'string' ? msg.selected : undefined); }
    const dir = env.dir;
    if (!dir) { ui.error('This workspace has no _ai folder.'); return undefined; }
    const id = typeof msg.id === 'string' ? msg.id : '';
    try {
        switch (msg.type) {
            case 'save': {
                const section = sectionOf(msg.section);
                if (!section) { return undefined; }
                const renames = optionRenamesOf(msg.renames, section);
                saveAspectSection(dir, section, env.topTom);
                const carried = renames ? env.renamed?.(renames) : undefined;
                env.changed?.();
                ui.info(`Section ${section.id} saved.`);
                if (carried) { ui.notice?.(carried); }
                return data(section.id, { saved: section.id, ...(carried ? { carried } : {}) });
            }
            case 'addSection': {
                const name = (await ui.ask('Short name of the new section: its folder under _ai/aspect_guidelines/, the name every level\'s choice names'))?.trim();
                if (!name) { return undefined; }
                if (!isAspectName(name) || name.includes('\\') || name === '.' || name === '..') { ui.error(`"${name}" is not a section name: ${NAME_RULE}.`); return undefined; }
                fs.mkdirSync(dir, { recursive: true });
                createAspectSection(dir, name, name, env.topTom);
                env.changed?.();
                return data(name);
            }
            case 'renameSection': {
                if (!id) { return undefined; }
                const to = (await ui.ask(`New short name of the section ${id} (its folder). The choices saved under "${id}" on every level are carried over to the new name.`, id))?.trim();
                if (!to || to === id) { return undefined; }
                if (!isAspectName(to) || to.includes('\\') || to === '.' || to === '..') { ui.error(`"${to}" is not a section name: ${NAME_RULE}.`); return undefined; }
                renameAspectSection(dir, id, to, env.topTom);
                const carried = env.renamed?.({ kind: 'section', from: id, to });
                env.changed?.();
                if (carried) { ui.notice?.(carried); }
                return data(to, { renamed: { from: id, to }, ...(carried ? { carried } : {}) });
            }
            case 'deleteSection': {
                if (!id) { return undefined; }
                const count = readSectionsForEdit(dir).find((s) => s.id === id)?.options.length ?? 0;
                if (!await ui.confirm(`Delete the section ${id} with its ${count} option${count === 1 ? '' : 's'}? Its folder _ai/aspect_guidelines/${id}/ is deleted.`, 'Delete')) { return undefined; }
                deleteAspectSection(dir, id);
                env.changed?.();
                return data(undefined, { deleted: id });
            }
            case 'openFolder':
                ui.reveal?.(id ? path.join(dir, id) : dir);
                return undefined;
            default:
                return undefined;
        }
    } catch (e) {
        ui.error((e as Error).message);
        return undefined;
    }
}

function liveEnv(): AspectSectionEditorEnv {
    let dir: string | undefined;
    try { dir = WsPaths.ai(ASPECT_GUIDELINES_FOLDER); } catch { dir = undefined; }
    return {
        dir,
        topTom: WsPaths.topTom,
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        renamed: (rename) => (require('./aspectChoiceCommands') as typeof import('./aspectChoiceCommands')).carryAspectChoicesOver(rename),
        changed: () => {
            /* eslint-disable @typescript-eslint/no-require-imports */
            try { (require('./aspectViewsRefresh') as typeof import('./aspectViewsRefresh')).refreshAspectViews(); } catch { /* nothing open */ }
            try { (require('./rolesEditor-handler') as typeof import('./rolesEditor-handler')).refreshRolesEditor(); } catch { /* not open */ }
            /* eslint-enable @typescript-eslint/no-require-imports */
        },
    };
}

/** Open (or reveal) the section editor, `section` chosen. */
export function openAspectSectionEditor(context: vscode.ExtensionContext, section?: string): void {
    if (panel) {
        panel.reveal();
        if (section) { void panel.webview.postMessage(aspectSectionEditorData(liveEnv(), section)); }
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
    bindPanel(context, created, section);
}

function bindPanel(context: vscode.ExtensionContext, bound: vscode.WebviewPanel, section?: string): void {
    panel = bound;
    const codiconsUri = bound.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')).toString();
    const ui: AspectSectionEditorUi = {
        ask: (prompt, value) => Promise.resolve(vscode.window.showInputBox({ prompt, value })),
        confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
        error: (message) => { void vscode.window.showErrorMessage(`${TITLE}: ${message}`); },
        info: (message) => { vscode.window.setStatusBarMessage(`$(check) ${message}`, 3000); },
        notice: (message) => { void vscode.window.showInformationMessage(`${TITLE}: ${message}`); },
        reveal: (file) => {
            if (!fs.existsSync(file)) { fs.mkdirSync(file, { recursive: true }); }
            void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(file));
        },
    };
    bound.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
        const answer = await handleAspectSectionEditorMessage(msg.type === 'ready' && section && !msg.selected ? { ...msg, selected: section } : msg, liveEnv(), ui);
        if (answer) { void bound.webview.postMessage(answer); }
    }, undefined, context.subscriptions);
    bound.onDidDispose(() => { if (panel === bound) { panel = undefined; } }, undefined, context.subscriptions);
    bound.webview.html = loadWebviewHtml(bound.webview, 'aspectSectionEditor', { init: { codiconsUri, ...(section ? { selected: section } : {}) } });
}

/** `tomAi.editor.aspectSections` (`{section}` chosen) and the reload serializer. */
export function registerAspectSectionEditorCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(ASPECT_SECTION_EDITOR_COMMAND, (args?: { section?: string }) => openAspectSectionEditor(context, args?.section)),
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(restored: vscode.WebviewPanel) {
                if (panel) { restored.dispose(); return; }
                restored.webview.options = {
                    enableScripts: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(context.extensionUri, 'media'),
                        vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                    ],
                };
                bindPanel(context, restored);
            },
        }),
    );
}
