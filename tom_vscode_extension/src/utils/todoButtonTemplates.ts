/**
 * The templates of the todo detail's Send and Queue buttons (and its Guide me
 * buttons): the buttons pick the template themselves, so the user does not
 * choose one per send. Two settings, both Anthropic user-message templates
 * (`anthropic.userMessageTemplates`), chosen on the Status Page:
 * `anthropic.todoButtonTemplates.userAction` for a todo marked 👤 user action
 * (default "Guide me through a user action"), `.other` for every other todo
 * (default "Execute TODO"). The buttons always send on Anthropic, whatever the
 * prompt queue's transport.
 *
 * vscode-free.
 */

export type TodoButtonTemplateUse = 'userAction' | 'other';

export const TODO_BUTTON_TEMPLATE_USES: readonly TodoButtonTemplateUse[] = ['userAction', 'other'];

/** Each use's default template id and what the Status Page calls it. */
export const TODO_BUTTON_TEMPLATE_INFO: Record<TodoButtonTemplateUse, { label: string; defaultId: string; defaultName: string }> = {
    userAction: { label: 'User-action todos', defaultId: 'guide-user-action', defaultName: 'Guide me through a user action' },
    other: { label: 'Other todos', defaultId: 'execute-todo', defaultName: 'Execute TODO' },
};

/** `anthropic.todoButtonTemplates` in the extension config. */
export type TodoButtonTemplatesSection = Partial<Record<TodoButtonTemplateUse, string>>;

interface TemplateRef { id: string; name?: string; template: string }

/** The use for a todo: user action or not. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- `user_action` is the todo's key
export function todoButtonTemplateUse(todo: { user_action?: unknown }): TodoButtonTemplateUse {
    return todo.user_action === true ? 'userAction' : 'other';
}

/** The template id a use runs: the setting, else the use's default. */
export function todoButtonTemplateId(section: TodoButtonTemplatesSection | undefined, use: TodoButtonTemplateUse): string {
    const chosen = section?.[use];
    return typeof chosen === 'string' && chosen.trim() ? chosen.trim() : TODO_BUTTON_TEMPLATE_INFO[use].defaultId;
}

/**
 * The template a use runs, looked up in the user-message templates: `{id, body}`,
 * or `{id, missing: true}` when that id is not (or no longer) among them.
 */
export function resolveTodoButtonTemplate(
    section: TodoButtonTemplatesSection | undefined,
    templates: readonly TemplateRef[] | undefined,
    use: TodoButtonTemplateUse,
): { id: string; name: string; body?: string; missing?: true } {
    const id = todoButtonTemplateId(section, use);
    const found = (templates ?? []).find((t) => t.id === id);
    if (!found || typeof found.template !== 'string') { return { id, name: id, missing: true }; }
    return { id, name: found.name || id, body: found.template };
}
