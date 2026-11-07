/**
 * The todo's record in every prompt of a todo iteration (DA-10, DA-22, C-10,
 * C-22): each prompt a `<prefix>*` walk sends for a todo — its pre-prompts,
 * main prompt and follow-ups — ends with the todo as stored, after the line
 * {@link TODO_YAML_INTRO}, whatever template or text the item uses. A custom
 * todo prompt needs no placeholder, and a stage running in a fresh session
 * (a per-iteration or per-prompt session) still has the whole todo.
 *
 * vscode-free.
 */

import * as yaml from 'yaml';

import { escapePlaceholders } from './placeholderEscape';

/** The line the record follows. */
export const TODO_YAML_INTRO = 'Here is the complete YAML of the todo:';

/**
 * The record as stored, for a prompt: every field, the decisions with their
 * answers, notes, references, scope, blocked_by — without the derived
 * `blocking` and the reader's own bookkeeping (`_sourceFile`); the fields the
 * reader keeps aside (`_extra`, unknown keys) are put back. Empty values are
 * left out.
 */
export function todoRecordForPrompt(todo: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const put = (key: string, value: unknown): void => {
        if (key === 'blocking' || key.startsWith('_')) { return; }
        if (value === undefined || value === null || value === '') { return; }
        if (Array.isArray(value) && value.length === 0) { return; }
        if (!(key in out)) { out[key] = value; }
    };
    for (const [key, value] of Object.entries(todo)) { put(key, value); }
    const extra = todo._extra;
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const [key, value] of Object.entries(extra as Record<string, unknown>)) { put(key, value); }
    }
    return out;
}

/**
 * The block appended to a prompt: the intro line, then the record as a YAML
 * fence, headed by the file it is stored in. Its `${` are escaped, so the
 * queue's placeholder passes leave the record as written.
 */
export function todoYamlBlock(todo: Record<string, unknown>, sourceFile?: string): string {
    const body = yaml.stringify(todoRecordForPrompt(todo), { lineWidth: 0 }).trimEnd();
    const head = sourceFile ? `# ${sourceFile}\n` : '';
    return escapePlaceholders(`${TODO_YAML_INTRO}\n\n\`\`\`yaml\n${head}${body}\n\`\`\``);
}

/** `prompt` with the block appended after a blank line. */
export function withTodoYaml(prompt: string, block: string | undefined): string {
    if (!block) { return prompt; }
    return `${prompt.replace(/\s+$/, '')}\n\n${block}`;
}

/** The stages of a queue item. */
export type IterationStage = 'prePrompt' | 'main' | 'followUp';

/**
 * Which todo a stage of a todo iteration carries: the main prompt the todo it
 * claimed; a pre-prompt (it runs before the first todo is claimed) the todo
 * the walk picks next; a follow-up (after the last) the todo walked last.
 * Undefined outside a todo iteration, or when there is no such todo.
 */
export function todoForStage(stage: IterationStage, ctx: { isTodoIteration: boolean; claimedId?: string; nextId?: string; lastId?: string }): string | undefined {
    if (!ctx.isTodoIteration) { return undefined; }
    switch (stage) {
        case 'main': return ctx.claimedId;
        case 'prePrompt': return ctx.nextId;
        case 'followUp': return ctx.lastId;
    }
}
