/**
 * The files of a new quest ("@T: Create New Quest", handlers/createQuest-handler.ts;
 * the pattern prompt `!create quest` runs the same command). Every file is
 * empty but for its headings; the quest's one todo defines the quest with the
 * user and writes the overview and the first todos. No vscode here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildIdPrefix } from '../tools/id-prefix-tools';
import { questCodeWorkspaceText } from './workspaceSetup';
import { DEFAULT_QUEST_NOTES_FILE, QUEST_NOTES_FOLDER } from './notesFiles';
import { QUEST_CONFIG_FOLDER, sharedExtensionConfigFileName } from './questConfigFiles';

/** Letters, digits and `_`. */
export const QUEST_ID_PATTERN = /^[A-Za-z0-9_]+$/;
/** The no-quest workspace's folder name, never a quest. */
export const RESERVED_QUEST_IDS = ['default'];

/** Why `id` cannot be a new quest under `questsDir`, or undefined when it can. */
export function questIdProblem(id: string, questsDir: string): string | undefined {
    if (!id) { return 'Enter a quest id.'; }
    if (!QUEST_ID_PATTERN.test(id)) { return 'A quest id has letters, digits and `_` only.'; }
    if (RESERVED_QUEST_IDS.includes(id)) { return `"${id}" is the no-quest workspace, not a quest.`; }
    if (fs.existsSync(path.join(questsDir, id))) { return `The quest "${id}" exists already (${path.join(questsDir, id)}).`; }
    return undefined;
}

/** A display name from an id: `my_quest` → `My Quest`. */
export function defaultQuestName(id: string): string {
    return id.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** The id of the quest's first todo, with the date code of `date` (tomAi_generateIdPrefix's rule). */
export function questSetupTodoId(date: Date): string {
    return `questsetup1_${buildIdPrefix(date)}-define-the-quest`;
}

const isoDate = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** What the first todo asks the agent that runs it to do. */
export function questSetupTodoDescription(id: string): string {
    return [
        `Define the quest ${id} with the user, then write it down.`,
        '',
        'Ask in rounds with tomAi_askUser, one topic per round (several questions in a round are fine), and wait for each answer before the next round:',
        '1. Purpose: what the quest is to achieve, and why.',
        '2. Scope: what belongs to it and what does not.',
        '3. Repositories and projects: the folders, repositories and packages it works on.',
        '4. Processes and roles: whether it follows a process from `_ai/processes/` (tomAi_listProcesses) and which roles (`_ai/roles/`) do its work.',
        '',
        `Then write \`overview.${id}.md\` (its sections are there, empty), set the process with tomAi_setProcessState when one was chosen, and create the first todos with tomAi_createQuestTodo: ids from tomAi_generateIdPrefix, each decision the user still has to make in \`decisions\` with status decision-needed. Show the user the overview and the todos and adjust them until they agree.`,
        '',
        `When the workspace keeps a list of its quests (\`_ai/workspaces/<workspace>.yaml\`, @T: Open AI Workspace Quests), add the quest to it; the quests themselves are the folders under \`_ai/quests/\`.`,
        '',
        `Last, bring \`short_description.${id}.md\` up to date — every active quest must have one (quests_and_processes.md): keep its title line, write 2–4 sentences on what the quest is for and what it covers (the repositories it works on included), and a \`**State:**\` line with where it stands now. It holds the current state only; the overview stays the long form.`,
    ].join('\n');
}

/** Indent a text as a YAML literal block's body. */
const yamlBlock = (text: string, indent: string): string => text.split('\n').map((l) => (l ? indent + l : '')).join('\n');

/**
 * `short_description.<quest>.md` (vscimpb145): a title line `# <Quest Name> (\`<id>\`)`, 2–4 sentences on what the
 * quest is for and what it covers, and a `**State:**` line — the current state only; the overview is the long form.
 * At creation the sentences are the purpose given, else a pointer to the setup todo.
 */
export function questShortDescriptionContent(id: string, name: string, purpose?: string, state?: string): string {
    const what = purpose?.trim() || `Being defined with the user by its first todo (\`questsetup1\`).`;
    return `# ${name} (\`${id}\`)\n\n${what}\n\n**State:** ${state?.trim() || 'New: its first todo defines it with the user.'}\n`;
}

/** The quest's files: name in the quest folder (with `/` for a file of a subfolder) → content. */
export function questScaffoldFiles(id: string, name: string, date: Date, purpose?: string): Array<{ name: string; content: string }> {
    const day = isoDate(date);
    const md = (title: string, ...sections: string[]): string =>
        [`# ${title}`, '', `**Quest ID:** ${id}`, ...sections.flatMap((s) => ['', `## ${s}`]), ''].join('\n');
    const todoId = questSetupTodoId(date);
    return [
        {
            name: `${id}.code-workspace`,
            content: questCodeWorkspaceText(),
        },
        {
            name: `overview.${id}.md`,
            content: [
                `# Quest Overview: ${name}`,
                '',
                `**Quest ID:** ${id}  `,
                `**Quest Name:** ${name}  `,
                `**Created:** ${day}  `,
                '**Status:** Active',
                ...['Purpose', 'Scope', 'Related Projects', 'Current State', 'Objectives / Backlog', 'Constraints', 'Related Quests'].flatMap((s) => ['', `## ${s}`]),
                '',
            ].join('\n'),
        },
        { name: `short_description.${id}.md`, content: questShortDescriptionContent(id, name, purpose) },
        {
            name: `todos.${id}.todo.yaml`,
            content: [
                '# yaml-language-server: $schema=../../schemas/yaml/todo.schema.json',
                `quest: ${id}`,
                `updated: ${day}`,
                '',
                'todos:',
                `  - id: ${todoId}`,
                '    title: Define the quest with the user',
                '    description: |-',
                yamlBlock(questSetupTodoDescription(id), '      '),
                '    status: not-started',
                '    priority: high',
                '    tags:',
                '      - quest-setup',
                `    created: ${day}`,
                `    updated: ${day}`,
                '',
            ].join('\n'),
        },
        {
            name: `${QUEST_NOTES_FOLDER}/${DEFAULT_QUEST_NOTES_FILE}`,
            content: `# Quest Notes — ${id}\n\nYour own notes. The assistant does not write here — the quest refresh maintains\n\`deferred.${id}.md\` instead.\n`,
        },
        { name: `deferred.${id}.md`, content: md(`Standing notes and deferred items — ${name}`, 'Standing notes', 'Deferred implementation steps') },
        { name: `progress.${id}.md`, content: `# Progress — ${id}\n\nChronological record of shipped work, executed todo IDs, and published\nversions. Newest first.\n` },
        { name: `open_topics.${id}.md`, content: md(`${name} — Open Topics`, 'Open Topics') },
        { name: `references.${id}.md`, content: md(`${name} — References`, 'Quest Files', 'Related Quests', 'Key Documents', 'External References') },
        { name: `quest_refresh.${id}.md`, content: `# Quest Refresh — attention notes (${id})\n\nItems that need your attention and are neither a plain todo nor stable\noverview/notes material. Remove entries once resolved.\n` },
        { name: `quest_documentation_update.${id}.md`, content: `# Documentation update notes — ${id}\n` },
        { name: `${QUEST_CONFIG_FOLDER}/${sharedExtensionConfigFileName(id)}`, content: `# Per-quest extension settings, the same on every machine (one top-level key per subsystem).\n{}\n` },
    ];
}

export interface QuestScaffoldResult {
    folder: string;
    files: string[];
    workspaceFile: string;
    todoId: string;
}

/**
 * Create `<questsDir>/<id>/` with the quest's files. No table lists the quests:
 * a workspace's quests are derived (its `_ai/workspaces/` list, the workspace
 * folder recorded when a window opens the quest; 02_wslayout-11). Throws when
 * the id cannot be a new quest (see {@link questIdProblem}).
 */
export function createQuestScaffold(questsDir: string, id: string, name: string, date = new Date(), purpose?: string): QuestScaffoldResult {
    const problem = questIdProblem(id, questsDir);
    if (problem) { throw new Error(problem); }
    const folder = path.join(questsDir, id);
    fs.mkdirSync(folder, { recursive: true });
    const files = questScaffoldFiles(id, name, date, purpose);
    for (const f of files) {
        const file = path.join(folder, ...f.name.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, f.content);
    }
    return {
        folder,
        files: files.map((f) => f.name),
        workspaceFile: path.join(folder, `${id}.code-workspace`),
        todoId: questSetupTodoId(date),
    };
}
