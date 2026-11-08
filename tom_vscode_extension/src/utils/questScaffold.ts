/**
 * The files of a new quest ("@T: Create New Quest", handlers/createQuest-handler.ts;
 * the pattern prompt `!create quest` runs the same command). Every file is
 * empty but for its headings; the quest's one todo defines the quest with the
 * user and writes the overview and the first todos. No vscode here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildIdPrefix } from '../tools/id-prefix-tools';
import { decisionsJournalHeader } from './decisionsJournalFormat';
import { questionsLogHeader } from './questionsLogFormat';

/** Letters, digits and `_`. */
export const QUEST_ID_PATTERN = /^[A-Za-z0-9_]+$/;
/** The no-quest workspace's folder name, never a quest. */
export const RESERVED_QUEST_IDS = ['default'];
/** Where the Active Quests table lives, relative to the workspace root. */
export const ACTIVE_QUESTS_FILE = path.join('_copilot_guidelines', 'quests_and_processes.md');
const ACTIVE_QUESTS_HEADING = '## Active Quests';

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
        `Then write \`overview.${id}.md\` (its sections are there, empty), set the process with tomAi_setProcessState when one was chosen, and create the first todos with tomAi_createQuestTodo: ids from tomAi_generateIdPrefix, each decision the user still has to make in \`decisions\` with status decision-needed. Show the user the overview and the todos and adjust them until they agree. Fill in the description of the quest's row in the Active Quests table (\`_copilot_guidelines/quests_and_processes.md\`).`,
    ].join('\n');
}

/** Indent a text as a YAML literal block's body. */
const yamlBlock = (text: string, indent: string): string => text.split('\n').map((l) => (l ? indent + l : '')).join('\n');

/** The quest's files: name in the quest folder → content. */
export function questScaffoldFiles(id: string, name: string, date: Date): Array<{ name: string; content: string }> {
    const day = isoDate(date);
    const md = (title: string, ...sections: string[]): string =>
        [`# ${title}`, '', `**Quest ID:** ${id}`, ...sections.flatMap((s) => ['', `## ${s}`]), ''].join('\n');
    const todoId = questSetupTodoId(date);
    return [
        {
            name: `${id}.code-workspace`,
            content: `${JSON.stringify({ folders: [{ path: '../../..' }] }, null, '\t')}\n`,
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
            name: `quest-notes.${id}.md`,
            content: `# Quest Notes — ${id}\n\nYour own notes. The assistant does not write here — the quest refresh maintains\n\`deferred.${id}.md\` instead.\n`,
        },
        { name: `deferred.${id}.md`, content: md(`Standing notes and deferred items — ${name}`, 'Standing notes', 'Deferred implementation steps') },
        { name: `progress.${id}.md`, content: `# Progress — ${id}\n\nChronological record of shipped work, executed todo IDs, and published\nversions. Newest first.\n` },
        { name: `decisions.${id}.md`, content: decisionsJournalHeader(id).replace(/\n+$/, '\n') },
        { name: `questions.${id}.md`, content: questionsLogHeader(id).replace(/\n+$/, '\n') },
        { name: `open_topics.${id}.md`, content: md(`${name} — Open Topics`, 'Open Topics') },
        { name: `references.${id}.md`, content: md(`${name} — References`, 'Quest Files', 'Related Quests', 'Key Documents', 'External References') },
        { name: `quest_refresh.${id}.md`, content: `# Quest Refresh — attention notes (${id})\n\nItems that need your attention and are neither a plain todo nor stable\noverview/notes material. Remove entries once resolved.\n` },
        { name: `quest_documentation_update.${id}.md`, content: `# Documentation update notes — ${id}\n` },
        { name: `extension_config.${id}.yaml`, content: `# Per-quest extension settings, the same on every machine (one top-level key per subsystem).\n{}\n` },
    ];
}

export type ActiveQuestsRegistration = 'added' | 'present' | 'noTable' | 'noFile';

/**
 * Add the quest's row to the Active Quests table of `file` (the first table
 * under `## Active Quests`), after its last row. `_bin/check_quest_registry.py`
 * holds that table to the quest folders.
 */
export function registerActiveQuest(file: string, id: string, name: string): ActiveQuestsRegistration {
    if (!fs.existsSync(file)) { return 'noFile'; }
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const heading = lines.findIndex((l) => l.trim() === ACTIVE_QUESTS_HEADING);
    if (heading < 0) { return 'noTable'; }
    let start = heading + 1;
    while (start < lines.length && !lines[start].startsWith('|') && !lines[start].startsWith('#')) { start++; }
    if (start >= lines.length || !lines[start].startsWith('|')) { return 'noTable'; }
    let end = start;
    while (end + 1 < lines.length && lines[end + 1].startsWith('|')) { end++; }
    const questPath = `\`_ai/quests/${id}/\``;
    if (lines.slice(start, end + 1).some((l) => l.includes(questPath))) { return 'present'; }
    lines.splice(end + 1, 0, `| ${id} | ${name} | (described by its first todo, ${'`'}questsetup1${'`'}) | ${questPath} |`);
    fs.writeFileSync(file, lines.join('\n'));
    return 'added';
}

export interface QuestScaffoldResult {
    folder: string;
    files: string[];
    workspaceFile: string;
    todoId: string;
    registration: ActiveQuestsRegistration;
}

/**
 * Create `<questsDir>/<id>/` with the quest's files and register it in the
 * Active Quests table of the workspace at `workspaceRoot`. Throws when the id
 * cannot be a new quest (see {@link questIdProblem}).
 */
export function createQuestScaffold(workspaceRoot: string, questsDir: string, id: string, name: string, date = new Date()): QuestScaffoldResult {
    const problem = questIdProblem(id, questsDir);
    if (problem) { throw new Error(problem); }
    const folder = path.join(questsDir, id);
    fs.mkdirSync(folder, { recursive: true });
    const files = questScaffoldFiles(id, name, date);
    for (const f of files) { fs.writeFileSync(path.join(folder, f.name), f.content); }
    return {
        folder,
        files: files.map((f) => f.name),
        workspaceFile: path.join(folder, `${id}.code-workspace`),
        todoId: questSetupTodoId(date),
        registration: registerActiveQuest(path.join(workspaceRoot, ACTIVE_QUESTS_FILE), id, name),
    };
}
