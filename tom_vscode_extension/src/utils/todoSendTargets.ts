/**
 * Send-a-TODO-to-chat target helpers.
 *
 * The Quest TODO panel's "Send to Chat" button and its template dropdown follow
 * the prompt queue's currently selected transport (`PromptQueueManager`'s
 * `defaultTransport`): when the queue is set to Copilot the dropdown lists the
 * Copilot todo templates and the button sends to Copilot chat; when it is set
 * to Anthropic the dropdown lists the Anthropic user-message templates and the
 * button routes through the Anthropic transport.
 *
 * This module owns the pure, vscode-free decision of *which templates to offer
 * and which one is pre-selected* for a given transport, so it can be unit
 * tested without the panel. The side-effecting send lives in the handler.
 */

import { EXECUTE_TODO_USER_MESSAGE_TEMPLATE_ID } from './sendToChatConfig';

export type TodoSendTransport = 'copilot' | 'anthropic';

export interface TodoTemplateOption {
    id: string;
    label: string;
}

export interface TodoSendTemplateChoices {
    transport: TodoSendTransport;
    templates: TodoTemplateOption[];
    /** Id of the option that should be pre-selected in the dropdown. */
    selected: string;
}

/**
 * Built-in Copilot TODO templates. The body is the prompt wrapper; the key is
 * both the dropdown id and its label. Also used as a fallback body when a
 * configured copilot template of the same name is missing.
 */
export const BUILTIN_TODO_TEMPLATES: Record<string, string> = {
    'TODO Execution': 'Do the following TODO:\n\n${originalPrompt}\n\nWork through the TODO completely. When you start working on the TODO change status to "In-Progress". If you notice anything that should be improved or also needs fixing, fix or do it. If you can\'t do it now, create a new todo so it is tracked.\n\nOnce the TODO is fully done, change status to "Completed".\n\nPlease verify everything stated is implemented exactly as described.',
    'Code Review': 'Quest: ${chat.quest}\n\nPlease review this code for quality, bugs, and improvements:\n${originalPrompt}\n\nFocus on:\n- Code quality and best practices\n- Potential bugs or edge cases\n- Security vulnerabilities\n- Performance issues\n- Suggestions for improvement',
    'Add Unit Tests': 'Quest: ${chat.quest}\n\nGenerate comprehensive unit tests for:\n${originalPrompt}\n\nRequirements:\n- High coverage\n- Test edge cases\n- Test error conditions\n- Use appropriate testing framework',
    'Refactor': 'Quest: ${chat.quest}\n\nRefactor this code for better quality:\n${originalPrompt}\n\nFocus on:\n- Readability\n- Maintainability\n- Performance\n- Best practices',
};

/** Minimal slice of {@link SendToChatConfig} the builder reads. */
export interface TodoTemplateSourceConfig {
    copilot?: {
        templates?: Record<string, { template?: string }>;
        defaultTemplate?: string;
    };
    anthropic?: {
        userMessageTemplates?: Array<{ id: string; name?: string; isDefault?: boolean }>;
    };
}

/**
 * Build the dropdown options + pre-selected id for the Quest TODO send button,
 * scoped to `transport`.
 *
 * Selection precedence:
 *   1. the queue's default template id (when it names an offered option),
 *   2. the transport's own default (copilot: `copilot.defaultTemplate`;
 *      anthropic: the template flagged `isDefault`, else the seeded
 *      "Execute TODO" template when present),
 *   3. a safe fallback (`TODO Execution` / `__none__`).
 *
 * @param queueDefaultTemplateId  `PromptQueueManager.defaultMessageTemplateId`
 *   — transport-scoped (an anthropic user-message template id, or a copilot
 *   template name). Ignored when it does not match an offered option.
 */
export function buildTodoSendTemplateChoices(
    transport: TodoSendTransport,
    config: TodoTemplateSourceConfig | undefined,
    queueDefaultTemplateId?: string,
): TodoSendTemplateChoices {
    if (transport === 'anthropic') {
        const userTemplates = config?.anthropic?.userMessageTemplates ?? [];
        const templates: TodoTemplateOption[] = [
            { id: '__none__', label: '(None)' },
            ...userTemplates.map((t) => ({ id: t.id, label: t.name || t.id })),
        ];
        const ids = new Set(templates.map((t) => t.id));
        const queuePick = queueDefaultTemplateId && ids.has(queueDefaultTemplateId) ? queueDefaultTemplateId : undefined;
        const flagged = userTemplates.find((t) => t.isDefault)?.id;
        const executeTodo = ids.has(EXECUTE_TODO_USER_MESSAGE_TEMPLATE_ID) ? EXECUTE_TODO_USER_MESSAGE_TEMPLATE_ID : undefined;
        const selected = queuePick || flagged || executeTodo || '__none__';
        return { transport, templates, selected };
    }

    const builtIn = Object.keys(BUILTIN_TODO_TEMPLATES).map((id) => ({ id, label: id }));
    const builtInIds = new Set(builtIn.map((b) => b.id));
    const configured = Object.keys(config?.copilot?.templates || {})
        .filter((key) => key !== '__answer_file__' && !builtInIds.has(key))
        .sort();
    const templates: TodoTemplateOption[] = [
        { id: '__none__', label: '(None)' },
        ...builtIn,
        ...configured.map((name) => ({ id: name, label: name })),
        { id: '__answer_file__', label: 'Answer Wrapper' },
    ];
    const ids = new Set(templates.map((t) => t.id));
    const queuePick = queueDefaultTemplateId && ids.has(queueDefaultTemplateId) ? queueDefaultTemplateId : undefined;
    const configDefault = String(config?.copilot?.defaultTemplate || 'TODO Execution');
    const selected = queuePick || (ids.has(configDefault) ? configDefault : 'TODO Execution');
    return { transport, templates, selected };
}
