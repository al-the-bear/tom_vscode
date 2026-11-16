/**
 * The user-message templates the extension seeds into `anthropic.userMessageTemplates`
 * (vscimpb120): which it adds, which earlier built-in bodies it brings to the
 * current text, and which templates are retired.
 *
 * - **With asking** (`with-asking`): before the work, every unclear point of
 *   the prompt is asked through the ask tools; decision-needed todos only for
 *   what the user explicitly leaves open.
 * - Every seeded template names the ask tools for what it leaves open
 *   ({@link ASK_TOOLS_PARAGRAPH}; Explain TODO asks in a Markdown document
 *   through tomAi_askInMdBrowser).
 * - An entry still holding an earlier built-in body (never edited) is brought
 *   to the current one, as the Assist prompts are; an edited entry is left alone.
 * - `with-context` and `with-role-banner` are retired: removed from the
 *   config, and a reference to them (a queue item, a timed request, a default)
 *   resolves to `default-raw`.
 *
 * vscode-free.
 */

import { EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_ID, PREVIOUS_EXPLAIN_TODO_BODIES, explainTodoTemplateEntry } from './explainTodoTemplate';

/** The ask tools, as every seeded template names them for what it leaves open. */
export const ASK_TOOLS_PARAGRAPH =
    '**Asking:** whatever is unclear or ambiguous, ask me instead of deciding it yourself, with the ask tools: '
    + '`tomAi_askUser` (one numbered question each, `choices` for the options, your recommendation first), '
    + '`tomAi_askUserPicker` for a pick from a list, `tomAi_askInMdBrowser` when the questions need a longer document. '
    + 'Call them without `timeoutMinutes` and wait for my answer. File a decision-needed todo only for what I explicitly leave open.';

/** Id of the seeded "With asking" template. */
export const WITH_ASKING_USER_MESSAGE_TEMPLATE_ID = 'with-asking';
export const WITH_ASKING_USER_MESSAGE_TEMPLATE_NAME = 'With asking';
export const WITH_ASKING_USER_MESSAGE_TEMPLATE_DESCRIPTION =
    'Asks every point the prompt leaves unclear or ambiguous through the ask tools (tomAi_askUser, tomAi_askUserPicker, tomAi_askInMdBrowser) before doing the work, so open points become answers instead of decision-needed todos.';
export const WITH_ASKING_USER_MESSAGE_TEMPLATE_BODY =
    'Before you do anything, read the prompt below and find every point it leaves unclear or ambiguous: scope, options, names, order, what counts as done. '
    + 'Ask me about all of them at once with the ask tools: `tomAi_askUser` (one numbered question each, `choices` for the options, your recommendation first), '
    + '`tomAi_askUserPicker` for a pick from a list, or `tomAi_askInMdBrowser` when the questions need a longer document. '
    + 'Call them without `timeoutMinutes` and wait for my answers, then do the work with them. '
    + 'Create decision-needed todos only for what I explicitly leave open. When nothing is unclear, start right away.\n\n'
    + '${userMessage}';

/** The "With asking" entry. */
export function withAskingTemplateEntry(): { id: string; name: string; description: string; template: string } {
    return {
        id: WITH_ASKING_USER_MESSAGE_TEMPLATE_ID,
        name: WITH_ASKING_USER_MESSAGE_TEMPLATE_NAME,
        description: WITH_ASKING_USER_MESSAGE_TEMPLATE_DESCRIPTION,
        template: WITH_ASKING_USER_MESSAGE_TEMPLATE_BODY,
    };
}

/** Id of the seeded "Execute TODO" template. */
export const EXECUTE_TODO_ID = 'execute-todo';

/** The Execute TODO body before the ask tools were named (vscimpb120): brought to the current one when unedited. */
export const PREVIOUS_EXECUTE_TODO_BODIES: readonly string[] = [
    'Do the following TODO:\n\n${userMessage}\n\n'
    + 'Work through the TODO completely. When you start working on the TODO change '
    + 'its status to "In-Progress". If you notice anything that should be improved '
    + 'or also needs fixing, fix or do it. If you cannot do it now, create a new '
    + 'todo so it is tracked.\n\nOnce the TODO is fully done, change its status to '
    + '"Completed".\n\nPlease verify everything stated is implemented exactly as '
    + 'described.',
];

/** The retired templates; a reference to one resolves to {@link RETIRED_TEMPLATE_FALLBACK_ID}. */
export const RETIRED_USER_MESSAGE_TEMPLATE_IDS: readonly string[] = ['with-context', 'with-role-banner'];
export const RETIRED_TEMPLATE_FALLBACK_ID = 'default-raw';

/** The template id to use for `id`: a retired one becomes `default-raw`, any other is kept. */
export function liveUserMessageTemplateId(id: string | undefined): string | undefined {
    return id && RETIRED_USER_MESSAGE_TEMPLATE_IDS.includes(id) ? RETIRED_TEMPLATE_FALLBACK_ID : id;
}

interface TemplateEntry { id?: string; name?: string; description?: string; template?: string; isDefault?: boolean }

/** The config slice the seeding works on. */
export interface SeedableConfig {
    anthropic?: {
        userMessageTemplates?: TemplateEntry[];
        todoButtonTemplates?: Record<string, string | undefined>;
        [key: string]: unknown;
    };
}

/**
 * Bring the seeded user-message templates up to date: add "With asking" when
 * missing; bring Execute TODO and Explain TODO from an earlier built-in body
 * to the current one (an edited body stays); remove the retired templates (a
 * default flag on one moves to `default-raw`) and drop a todo-button setting
 * naming one (its default applies). Answers what changed ([] when nothing).
 */
export function ensureSeededUserMessageTemplates(config: SeedableConfig, currentExecuteTodoBody: string): string[] {
    const anthropic = (config.anthropic ??= {});
    const templates = (anthropic.userMessageTemplates ??= []);
    const changes: string[] = [];

    if (!templates.some((t) => t.id === WITH_ASKING_USER_MESSAGE_TEMPLATE_ID)) {
        templates.push(withAskingTemplateEntry());
        changes.push('added "With asking"');
    }
    const upgrade = (id: string, previous: readonly string[], current: string, label: string): void => {
        const t = templates.find((e) => e.id === id);
        if (t && typeof t.template === 'string' && t.template !== current && previous.includes(t.template)) {
            t.template = current;
            changes.push(`${label}: the built-in text brought up to date`);
        }
    };
    upgrade(EXECUTE_TODO_ID, PREVIOUS_EXECUTE_TODO_BODIES, currentExecuteTodoBody, 'Execute TODO');
    upgrade(EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_ID, PREVIOUS_EXPLAIN_TODO_BODIES, explainTodoTemplateEntry().template as string, 'Explain TODO');

    const retired = templates.filter((t) => typeof t.id === 'string' && RETIRED_USER_MESSAGE_TEMPLATE_IDS.includes(t.id));
    if (retired.length) {
        const wasDefault = retired.some((t) => t.isDefault === true);
        anthropic.userMessageTemplates = templates.filter((t) => !retired.includes(t));
        changes.push(`removed ${retired.map((t) => `"${t.id}"`).join(', ')}`);
        if (wasDefault && !anthropic.userMessageTemplates.some((t) => t.isDefault === true)) {
            const raw = anthropic.userMessageTemplates.find((t) => t.id === RETIRED_TEMPLATE_FALLBACK_ID);
            if (raw) { raw.isDefault = true; changes.push(`"${RETIRED_TEMPLATE_FALLBACK_ID}" is the default now`); }
        }
    }
    const buttons = anthropic.todoButtonTemplates;
    if (buttons && typeof buttons === 'object') {
        for (const [use, id] of Object.entries(buttons)) {
            if (typeof id === 'string' && RETIRED_USER_MESSAGE_TEMPLATE_IDS.includes(id)) {
                delete buttons[use];
                changes.push(`todo button template "${use}" named "${id}": its default applies`);
            }
        }
    }
    return changes;
}
