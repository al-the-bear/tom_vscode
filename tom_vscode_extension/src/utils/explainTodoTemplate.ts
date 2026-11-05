/**
 * The "Explain TODO" Anthropic user-message template: a todo sent with it is
 * explained to the user in detail, the open points are asked through
 * tomAi_askUser, and the todo is changed from the answers — nothing else is
 * done. It took the place of the "Explain-then-ask scaffold"
 * (`explain-and-ask`), whose id the `_ai` format migration renames
 * (aiFormatMigration.ts, format version 4).
 *
 * vscode-free (the migration uses it); sendToChatConfig.ts seeds it.
 */

/** Id of the seeded "Explain TODO" Anthropic user-message template. */
export const EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_ID = 'explain-todo';

/** The id it replaced. */
export const LEGACY_EXPLAIN_AND_ASK_TEMPLATE_ID = 'explain-and-ask';

/** Display name. */
export const EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_NAME = 'Explain TODO';

export const EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_DESCRIPTION =
    'Explains a todo in detail (what it changes, why, its open decisions and their options), asks the user through tomAi_askUser, and changes the todo from the answers (decisions, description, notes). Does not do the work.';

export const EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY = `# Explain TODO

The todo below is to be **explained, not done**. Explain it to me in detail, ask me what is still open, and change the todo from my answers.

## The todo

\${userMessage}

## How

1. **Read it in full.** The todo's YAML is above; when only an id or a \`<path>/<file>.todo.yaml/<id>\` reference is there, read it with \`tomAi_getQuestTodo\` (quest \`\${quest}\` unless the reference names another). Read what it points to — its references, the todos in \`blocked_by\` and \`blocking\`, the files and code it names — so the explanation describes the situation as it is now, not as it was when the todo was filed.

2. **Explain it**, in plain words:
   - **what it changes**: the files, modules, formats and behaviour, and what I will see differently afterwards;
   - **why**: the problem it solves, where it comes from (its references and earlier decisions), and what depends on it;
   - **how it would be done**, step by step, and how it is checked (tests, the DONE condition);
   - **its open decisions**: each with its options, what each option means in practice, and your recommendation with the reason;
   - anything **unclear, contradictory or stale** in it.

3. **Ask me through \`tomAi_askUser\`**, never in your reply text: one numbered question per open decision and per unclear point, each naming the options and your recommendation, and a last one asking whether the todo should change in any other way (scope, priority, order). Wait for my answer.

4. **Change the todo from my answers** with \`tomAi_updateQuestTodo\`:
   - write each answer into its \`decisions[].decision\`;
   - rewrite the description where an answer changes what is to be done, keeping everything in it that still holds;
   - add a dated note saying what was clarified — \`notes\` is replaced, not appended to, so read the existing notes first and send them with the new one;
   - when every decision is answered and the status is \`decision-needed\`, set it to \`not-started\` in the same update.

5. **Do not start the work**: no code and no file changes besides the todo, and no other todos. End by telling me what changed in the todo.

The todo is not done by this, so do not report its TODO response value.`;

export interface UserMessageTemplateEntry {
    id: string;
    name?: string;
    description?: string;
    template?: string;
    isDefault?: boolean;
}

/** The Explain TODO entry, keeping `isDefault` from the entry it replaces. */
export function explainTodoTemplateEntry(replacing?: { isDefault?: boolean }): UserMessageTemplateEntry {
    return {
        id: EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_ID,
        name: EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_NAME,
        description: EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_DESCRIPTION,
        template: EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY,
        ...(replacing?.isDefault ? { isDefault: true } : {}),
    };
}

/**
 * A config object with the old template renamed: its `anthropic.userMessageTemplates`
 * entry becomes Explain TODO (dropped when Explain TODO is already there), and
 * every other string naming the old id — a default template, a queue or timed
 * entry's template — names the new one. Answers how many places changed.
 */
export function renameExplainTemplate(config: unknown): { config: unknown; changed: number } {
    let changed = 0;
    const walk = (node: unknown, inTemplates: boolean): unknown => {
        if (typeof node === 'string') {
            if (node === LEGACY_EXPLAIN_AND_ASK_TEMPLATE_ID) { changed++; return EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_ID; }
            return node;
        }
        if (Array.isArray(node)) {
            if (inTemplates) {
                const hasNew = node.some((t) => (t as { id?: unknown })?.id === EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_ID);
                const out: unknown[] = [];
                for (const t of node) {
                    if ((t as { id?: unknown })?.id === LEGACY_EXPLAIN_AND_ASK_TEMPLATE_ID) {
                        changed++;
                        if (!hasNew) { out.push(explainTodoTemplateEntry(t as { isDefault?: boolean })); }
                        continue;
                    }
                    out.push(t);
                }
                return out;
            }
            return node.map((v) => walk(v, false));
        }
        if (node && typeof node === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
                out[k] = walk(v, k === 'userMessageTemplates');
            }
            return out;
        }
        return node;
    };
    const next = walk(config, false);
    return { config: next, changed };
}
