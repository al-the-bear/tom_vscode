/**
 * The host side both QUEST NOTES views share (@TOM's `tomAi.questNotes`,
 * sidebarNotes-handler.ts, and @TOM INFO's `tomAi.questNotesPanel`,
 * questNotesPanel-handler.ts): the notes files of the active quest
 * (`_ai/quests/<quest>/notes/*.md`, rules in utils/notesFiles.ts), the file
 * the window shows, switching it and creating a new one.
 *
 * Each view owns a {@link QuestNotesSession}: its `NotepadFileStorage` on the
 * file selected, the list for the page's picker, and the handling of the
 * picker's messages. The choice is kept per window and quest (workspaceState
 * {@link QUEST_NOTES_CHOICE_KEY}) and is one for both views: a switch in one
 * view reaches the other through {@link onDidChangeQuestNotesChoice}.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { layoutWorkspaceFolder } from '../../utils/workspaceLayout';
import { WsPaths } from '../../utils/workspacePaths';
import {
    DEFAULT_QUEST_NOTES_PATTERN,
    listQuestNotesFiles,
    newNotesFileName,
    pickQuestNotesFile,
    questNotesHeader,
    resolveDefaultQuestNotes,
    type DefaultQuestNotes,
    type QuestNotesFile,
} from '../../utils/notesFiles';
import { NotepadFileStorage } from './notepadFileStorage';

/** workspaceState: `{ [questId]: <notes file name> }`, the file each quest's QUEST NOTES views show in this window. */
export const QUEST_NOTES_CHOICE_KEY = 'tomAi.notes.questNotesFile';

/** The messages of the pages' picker and New button. */
export const QUEST_NOTES_PICKER_MESSAGES = ['selectNotesFile', 'newNotesFile'] as const;

const choiceChanged = new vscode.EventEmitter<void>();
/** Fires when the window's choice of notes file changed (a switch, a new file). */
export const onDidChangeQuestNotesChoice = choiceChanged.event;

/** The active quest's notes. */
export interface ActiveQuestNotes {
    questId: string;
    /** The default notes file and the notes folder. */
    defaultNotes: DefaultQuestNotes;
    /** The picker's list: the default first, then the others by name. */
    files: QuestNotesFile[];
    /** The file the window shows. */
    selected: QuestNotesFile;
}

/** What a page's picker is told (part of the view's state message). */
export interface QuestNotesPickerState {
    notesFiles: Array<{ name: string; isDefault: boolean }>;
    /** The name of the file shown; '' without a quest. */
    notesFile: string;
}

function activeQuestFolder(): { questId: string; questFolder: string; wsRoot: string } | null {
    const wsRoot = layoutWorkspaceFolder();
    const wsFile = vscode.workspace.workspaceFile?.fsPath;
    if (!wsRoot || !wsFile) { return null; }
    const questId = path.basename(wsFile).replace(/\.code-workspace$/, '').trim();
    if (!questId) { return null; }
    const questFolder = WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);
    try {
        if (!fs.statSync(questFolder).isDirectory()) { return null; }
    } catch { return null; }
    return { questId, questFolder, wsRoot };
}

/** The default notes file as `tomAi.notes.questNotesPattern` names it, absolute. */
function configuredDefaultNotesFile(questId: string, wsRoot: string): string {
    const pattern = vscode.workspace.getConfiguration('tomAi').get<string>('notes.questNotesPattern') || DEFAULT_QUEST_NOTES_PATTERN;
    const rel = pattern
        .replace(/\$\{quest\}/g, questId)
        .replace(/\$\{workspaceFolder\}/g, wsRoot);
    return path.isAbsolute(rel) ? rel : path.join(wsRoot, rel);
}

function readChoices(context: vscode.ExtensionContext): Record<string, string> {
    const raw = context.workspaceState.get<Record<string, string>>(QUEST_NOTES_CHOICE_KEY);
    return raw && typeof raw === 'object' ? raw : {};
}

/**
 * The active quest's notes files and the one this window shows; null while no
 * quest is open (no `.code-workspace`, or its quest folder is missing). A kept
 * choice whose file is gone falls back to the default.
 */
export function activeQuestNotes(context: vscode.ExtensionContext): ActiveQuestNotes | null {
    const quest = activeQuestFolder();
    if (!quest) { return null; }
    const defaultNotes = resolveDefaultQuestNotes(configuredDefaultNotesFile(quest.questId, quest.wsRoot), quest.questFolder, quest.questId);
    const files = listQuestNotesFiles(defaultNotes);
    return { questId: quest.questId, defaultNotes, files, selected: pickQuestNotesFile(files, readChoices(context)[quest.questId]) };
}

/** Keep `name` as the file the quest's views show in this window, and tell the views. */
async function keepChoice(context: vscode.ExtensionContext, questId: string, name: string): Promise<void> {
    await context.workspaceState.update(QUEST_NOTES_CHOICE_KEY, { ...readChoices(context), [questId]: name });
    choiceChanged.fire();
}

/**
 * Ask for a name (input box) and create that notes file in the active quest's
 * notes folder with a `# <name>` heading; it becomes the file shown. Answers
 * the new file's name, undefined when nothing was created (no quest, the box
 * dismissed, a refused name).
 */
export async function createQuestNotesFile(context: vscode.ExtensionContext): Promise<string | undefined> {
    const before = activeQuestNotes(context);
    if (!before) {
        vscode.window.showWarningMessage('No quest is open: a notes file belongs to a quest.');
        return undefined;
    }
    const input = await vscode.window.showInputBox({
        title: 'New notes file',
        prompt: `Name of the new notes file of quest ${before.questId} (.md is added)`,
        placeHolder: 'e.g. meeting-notes',
        validateInput: (value) => {
            const check = newNotesFileName(value, before.files.map((f) => f.name));
            return check.ok ? undefined : check.problem;
        },
    });
    if (input === undefined) { return undefined; }
    // Listed again: the folder may have changed while the box was open.
    const now = activeQuestNotes(context);
    if (!now || now.questId !== before.questId) { return undefined; }
    const check = newNotesFileName(input, now.files.map((f) => f.name));
    if (!check.ok) {
        vscode.window.showWarningMessage(check.problem);
        return undefined;
    }
    const filePath = path.join(now.defaultNotes.folder, check.fileName);
    try {
        fs.mkdirSync(now.defaultNotes.folder, { recursive: true });
        fs.writeFileSync(filePath, check.heading, { encoding: 'utf-8', flag: 'wx' });
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to create the notes file: ${e}`);
        return undefined;
    }
    await keepChoice(context, now.questId, check.fileName);
    return check.fileName;
}

/** One QUEST NOTES view's hold on the notes: the storage on the file selected and the picker's list. */
export class QuestNotesSession {
    private _storage: NotepadFileStorage | null = null;
    private _notes: ActiveQuestNotes | null = null;
    private readonly _subscription: vscode.Disposable;

    /**
     * @param onChange the view posts its state: `external` true for a change of the file on disk (the storage is
     *        current), false after the choice changed (the session is loaded again).
     * @param pollMs the poll interval of the file watch; tests pass a short one.
     */
    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _onChange: (external: boolean) => void,
        private readonly _pollMs?: number,
    ) {
        this._subscription = onDidChangeQuestNotesChoice(() => {
            this.load();
            this._onChange(false);
        });
    }

    /** The storage on the file shown, as of the last {@link load}; null without a quest. */
    get storage(): NotepadFileStorage | null { return this._storage; }
    /** The active quest's id as of the last {@link load}; '' without one. */
    get questId(): string { return this._notes?.questId ?? ''; }

    /** The picker's part of the view's state. */
    get pickerState(): QuestNotesPickerState {
        return {
            notesFiles: (this._notes?.files ?? []).map((f) => ({ name: f.name, isDefault: f.isDefault })),
            notesFile: this._notes?.selected.name ?? '',
        };
    }

    /**
     * Resolve the active quest's notes and read the file shown. A quest without a default notes file gets it,
     * with its header, the moment a view shows it. The storage is rebuilt only when the file changes.
     */
    load(): NotepadFileStorage | null {
        const notes = activeQuestNotes(this._context);
        this._notes = notes;
        if (!notes) {
            this._storage?.dispose();
            this._storage = null;
            return null;
        }
        const filePath = notes.selected.filePath;
        if (this._storage?.path !== filePath) {
            this._storage?.dispose();
            this._storage = new NotepadFileStorage(filePath);
            this._storage.watch(() => this._onChange(true), this._pollMs);
        }
        if (!fs.existsSync(filePath)) {
            this._storage.ensureFile();
            this._storage.save(questNotesHeader(notes.questId));
        }
        this._storage.load();
        return this._storage;
    }

    /**
     * A message of the page's picker: `selectNotesFile` (`name`) shows that file of the list, `newNotesFile` asks
     * for a name and creates the file. Answers false for any other message. The view hears of the change through
     * its `onChange`.
     */
    async handleMessage(msg: { type?: unknown; name?: unknown }): Promise<boolean> {
        switch (msg?.type) {
            case 'selectNotesFile': {
                const notes = activeQuestNotes(this._context);
                const file = notes?.files.find((f) => f.name === msg.name);
                if (notes && file) {
                    await keepChoice(this._context, notes.questId, file.name);
                } else {
                    // The file is gone (or no quest): the page gets the list as it is.
                    this.load();
                    this._onChange(false);
                }
                return true;
            }
            case 'newNotesFile':
                await createQuestNotesFile(this._context);
                return true;
            default:
                return false;
        }
    }

    dispose(): void {
        this._subscription.dispose();
        this._storage?.dispose();
        this._storage = null;
        this._notes = null;
    }
}
