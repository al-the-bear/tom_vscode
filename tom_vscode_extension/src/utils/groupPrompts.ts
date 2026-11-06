/**
 * Group prompts: the prompt a todo-group walk (`<prefix>*` queue item) sends
 * for every todo of the group. Pure rules; the files are read and written by
 * `src/services/groupPromptStore.ts`, edited in the group prompt editor and
 * picked from the todo panel's group headline.
 *
 * Where they live (`_ai` travels to every host):
 * - global: `_ai/group_prompts/default.md` (the default prompt; without it the
 *   built-in one) and `_ai/group_prompts/additions/<name>.md`;
 * - per quest: `_ai/quests/<quest>/group_prompts/default.md` (overrides the
 *   default for that quest), `additions/<name>.md` and `prompts/<name>.md`
 *   (whole prompts used instead of the default).
 *
 * An addition is appended to the default, after a blank line.
 */

export type GroupPromptScope = 'global' | 'quest';
export type GroupPromptKind = 'default' | 'addition' | 'prompt';

/** One group prompt file. `name` is '' for a default. */
export interface GroupPromptEntry {
    scope: GroupPromptScope;
    kind: GroupPromptKind;
    name: string;
    text: string;
}

/** One line of the "Queue Group Prompt" picker: what it is called and the text the walk sends. */
export interface GroupPromptChoice {
    label: string;
    description: string;
    text: string;
}

/** The folder name of the group prompts, under `_ai/` and under a quest folder. */
export const GROUP_PROMPTS_FOLDER = 'group_prompts';

/** The kinds each scope holds: a whole prompt of its own is a quest's. */
export const GROUP_PROMPT_KINDS: Readonly<Record<GroupPromptScope, readonly GroupPromptKind[]>> = {
    global: ['default', 'addition'],
    quest: ['default', 'addition', 'prompt'],
};

/** The sub-folder of the named kinds. */
const KIND_FOLDERS: Readonly<Record<'addition' | 'prompt', string>> = { addition: 'additions', prompt: 'prompts' };

/**
 * The default group prompt when `_ai/group_prompts/default.md` does not exist.
 * `${repeatTodoId}`, `${repeatTodoTitle}` and `${repeatNumber}` are filled in
 * by the queue for the todo each send of the walk picked; `${quest}` is the
 * window's quest.
 */
export const BUILTIN_GROUP_PROMPT =
    'Do the quest todo ${repeatTodoId} — ${repeatTodoTitle} (todo ${repeatNumber} of this group walk). '
    + 'Read it in full with tomAi_getQuestTodo (quest ${quest}) before you start.\n\n'
    + 'Work through the TODO completely. When you start working on the TODO change its status to "In-Progress". '
    + 'If you notice anything that should be improved or also needs fixing, fix or do it. If you cannot do it now, '
    + 'create a new todo so it is tracked.\n\n'
    + 'Important: as soon as you answer, the queue sends the next todo. Processes, background commands or '
    + 'agents you start cannot call you back after that, and their results are lost. Wait actively for '
    + 'everything you start (poll or block until it has finished) and check its result before you answer.\n\n'
    + 'Once the TODO is fully done, change its status to "Completed" and report it with the response value '
    + '`TODO` = `_ai/quests/${quest}/<sourceFile>/${repeatTodoId}` (`sourceFile` as tomAi_getQuestTodo names it).\n\n'
    + 'Please verify everything stated is implemented exactly as described.';

/** The file of an entry, relative to its scope's group prompt folder. */
export function groupPromptFileName(kind: GroupPromptKind, name: string): string {
    return kind === 'default' ? 'default.md' : `${KIND_FOLDERS[kind]}/${name}.md`;
}

/** The kind and name of a file relative to a group prompt folder, or undefined for any other file. */
export function groupPromptOfFile(relativePath: string): { kind: GroupPromptKind; name: string } | undefined {
    const parts = relativePath.split(/[\\/]/);
    if (parts.length === 1 && parts[0] === 'default.md') { return { kind: 'default', name: '' }; }
    if (parts.length !== 2 || !parts[1].endsWith('.md')) { return undefined; }
    const name = parts[1].slice(0, -3);
    if (groupPromptNameError(name)) { return undefined; }
    if (parts[0] === KIND_FOLDERS.addition) { return { kind: 'addition', name }; }
    if (parts[0] === KIND_FOLDERS.prompt) { return { kind: 'prompt', name }; }
    return undefined;
}

/** Why `name` cannot name an addition or prompt, or undefined when it can (it becomes `<name>.md`). */
export function groupPromptNameError(name: string): string | undefined {
    if (!name.trim()) { return 'Give it a name.'; }
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(name)) {
        return 'Letters, digits, space, "_", "-" and "." only, starting with a letter or digit.';
    }
    if (name.endsWith('.') || name.endsWith(' ')) { return 'The name must not end in "." or a space.'; }
    return undefined;
}

/** The key of an entry, unique within one quest's set. */
export function groupPromptKey(entry: Pick<GroupPromptEntry, 'scope' | 'kind' | 'name'>): string {
    return `${entry.scope}:${entry.kind}:${entry.name}`;
}

/** Natural order of names: `step2` before `step10`. */
function byName(a: GroupPromptEntry, b: GroupPromptEntry): number {
    return a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** The default the walks of this set use, and where it comes from. */
export function effectiveGroupDefault(entries: readonly GroupPromptEntry[]): { text: string; from: 'quest' | 'global' | 'builtin' } {
    const quest = entries.find((e) => e.scope === 'quest' && e.kind === 'default');
    if (quest) { return { text: quest.text, from: 'quest' }; }
    const global = entries.find((e) => e.scope === 'global' && e.kind === 'default');
    if (global) { return { text: global.text, from: 'global' }; }
    return { text: BUILTIN_GROUP_PROMPT, from: 'builtin' };
}

/** The default followed by an addition, after a blank line. */
export function composeGroupPrompt(defaultText: string, addition: string): string {
    const head = defaultText.replace(/\s+$/, '');
    const tail = addition.replace(/^\s+/, '').replace(/\s+$/, '');
    if (!tail) { return head; }
    return head ? `${head}\n\n${tail}` : tail;
}

/**
 * The picker's choices, in this order: the default; the default with each
 * global addition; the default with each of the quest's additions; each of the
 * quest's own prompts. Names in natural order within each block.
 */
export function groupPromptChoices(entries: readonly GroupPromptEntry[], questId: string): GroupPromptChoice[] {
    const def = effectiveGroupDefault(entries);
    const from = def.from === 'quest' ? `${questId}'s default` : def.from === 'global' ? 'the default' : 'the built-in default';
    const of = (scope: GroupPromptScope, kind: GroupPromptKind) => entries.filter((e) => e.scope === scope && e.kind === kind).sort(byName);
    return [
        { label: 'Default', description: from, text: def.text },
        ...of('global', 'addition').map((e) => ({ label: `Default + ${e.name}`, description: 'global addition', text: composeGroupPrompt(def.text, e.text) })),
        ...of('quest', 'addition').map((e) => ({ label: `Default + ${e.name}`, description: `${questId} addition`, text: composeGroupPrompt(def.text, e.text) })),
        ...of('quest', 'prompt').map((e) => ({ label: e.name, description: `${questId} prompt`, text: e.text })),
    ];
}

/**
 * What a walk sends with the entry `key` of this set: a default as written
 * (with a note when the quest's own default replaces it), an addition after
 * the default the quest uses, a quest prompt as written. Undefined for an
 * unknown key.
 */
export function groupPromptPreview(entries: readonly GroupPromptEntry[], key: string): { text: string; note: string } | undefined {
    const entry = entries.find((e) => groupPromptKey(e) === key);
    if (!entry) { return undefined; }
    const def = effectiveGroupDefault(entries);
    if (entry.kind === 'default') {
        const replaced = entry.scope === 'global' && def.from === 'quest';
        return { text: entry.text, note: replaced ? 'this quest uses its own default instead' : 'sent as it is' };
    }
    if (entry.kind === 'addition') {
        return { text: composeGroupPrompt(def.text, entry.text), note: `after ${def.from === 'quest' ? "the quest's" : def.from === 'global' ? 'the' : 'the built-in'} default` };
    }
    return { text: entry.text, note: 'sent instead of the default' };
}
