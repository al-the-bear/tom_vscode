/**
 * The todo done notification template (`todoPanel.doneNotificationTemplate`,
 * vscimpb146). A todo's done notification is its `on_done` `notify`
 * (utils/todoOnDoneRun.ts): its own `notify_prompt`, else this template; with
 * neither there is none — there is no built-in text. It is delivered into the
 * run and session that queued the todo (`queuedBy`, utils/queuedBy.ts). The
 * todo panel's Done notification box (off by default, per quest, disabled
 * while no template is set) decides whether the panel's items record
 * `queuedBy`.
 *
 * vscode-free and pure.
 */

/** The placeholders the template takes (filled by `fillTodoPlaceholders`), for the editor's help. */
export const TODO_DONE_NOTIFICATION_PLACEHOLDERS: ReadonlyArray<[string, string]> = [
    ['${todoId}', 'the todo\'s id'],
    ['${todoTitle}', 'its title'],
    ['${todoFile}', 'its *.todo.yaml'],
    ['${todoStatus}', 'its status (completed)'],
    ['${itemOutcome}', '`completed`'],
    ['${itemAnswer}', 'the answer stored on the todo (last_answer)'],
    ['${todoLastAnswer}', 'the same'],
    ['${todoOnDone}', 'its on_done block'],
    ['${filedBy}', 'its filed_by in one line'],
    ['${reportTo}', 'its on_done report_to'],
    ['${senderQuest}', 'the quest the todo was completed in'],
    ['${senderRun}', 'and its run'],
];

/** The configured template, undefined when none is set (then a todo without its own notify_prompt gets no notification). */
export function todoDoneNotificationTemplate(config: { todoPanel?: { doneNotificationTemplate?: string } } | null | undefined): string | undefined {
    const own = config?.todoPanel?.doneNotificationTemplate;
    return own && own.trim() ? own : undefined;
}
