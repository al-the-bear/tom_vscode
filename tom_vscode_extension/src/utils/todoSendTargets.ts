/**
 * Send-a-TODO-to-chat target helpers.
 *
 * The Quest TODO panel's "Send to Chat" button follows the prompt queue's
 * currently selected transport (`PromptQueueManager`'s `defaultTransport`):
 * Copilot chat or the Anthropic transport. The template dropdown lists the one
 * template store, the Anthropic user-message templates, for both.
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

/** One stacked todo, ready for prompt embedding. */
export interface StackedTodoFragment {
    /** YAML list fragment for the todo (a single `- id: ...` entry). */
    yaml: string;
    /** Qualified todo ref (`<ws-path>/<file>.todo.yaml/<id>`), or the bare id. */
    ref: string;
}

/**
 * Build the combined prompt body for a STACK of todos sent as one message.
 *
 * Each fragment is a one-entry YAML list (`- id: ...`), so joining them with a
 * newline yields a single valid YAML todo list. The `REQUIRED responseValue`
 * footer gets one line per todo; keys must be DISTINCT so the answer scanner
 * can resolve each todo separately — a single todo keeps the classic `#TODO=`
 * key, multiple todos use `#TODO_1=`, `#TODO_2=`, … in stack order.
 *
 * Pure so it can be unit tested; the handler feeds it the fragments it built
 * with `_todoYamlFragment` and routes the result through the same template
 * embedding (`${originalPrompt}` / `${userMessage}`) as a single todo.
 */
export function buildStackedTodoPrompt(fragments: StackedTodoFragment[]): string {
    const yamlBlock = fragments.map((f) => f.yaml.trim()).join('\n');
    const required = fragments.length === 1
        ? `REQUIRED: Add responseValue #TODO=${fragments[0].ref}`
        : fragments
            .map((f, i) => `REQUIRED: Add responseValue #TODO_${i + 1}=${f.ref}`)
            .join('\n');
    return `${yamlBlock}\n\n${required}\n\n`;
}

/** Minimal slice of {@link SendToChatConfig} the builder reads. */
export interface TodoTemplateSourceConfig {
    anthropic?: {
        userMessageTemplates?: Array<{ id: string; name?: string; isDefault?: boolean }>;
    };
}

/**
 * Build the dropdown options + pre-selected id for the Quest TODO send button.
 * Both transports offer the one template store, the Anthropic user-message
 * templates; on Copilot the send is put into the Copilot Queue Wrapper as well
 * (src/utils/copilotTemplates.ts), so there is no wrapper option to pick.
 *
 * Selection precedence:
 *   1. the queue's default template id (when it names an offered option),
 *   2. the template flagged `isDefault`,
 *   3. the seeded "Execute TODO" template when present,
 *   4. `__none__`.
 *
 * @param queueDefaultTemplateId  `PromptQueueManager.defaultMessageTemplateId`.
 *   Ignored when it does not match an offered option.
 */
export function buildTodoSendTemplateChoices(
    transport: TodoSendTransport,
    config: TodoTemplateSourceConfig | undefined,
    queueDefaultTemplateId?: string,
): TodoSendTemplateChoices {
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
