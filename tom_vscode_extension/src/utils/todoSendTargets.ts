/**
 * Send-a-TODO-to-chat target helpers.
 *
 * The Quest TODO panel's "Send to Chat" button sends on the Anthropic
 * transport. The template dropdown lists the one template store, the
 * Anthropic user-message templates.
 *
 * This module owns the pure, vscode-free decision of *which templates to offer
 * and which one is pre-selected* for a given transport, so it can be unit
 * tested without the panel. The side-effecting send lives in the handler.
 */

import { RUN_DEFAULT_CHOICE, runDefaultLabel } from './runDefaultChoice';

export type TodoSendTransport = 'anthropic';

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
    /** The todo's part of the prompt: {@link todoSendBlock}. */
    yaml: string;
    /** Qualified todo ref (`<ws-path>/<file>.todo.yaml/<id>`), or the bare id. */
    ref: string;
}

/**
 * A todo as the todo panel sends it (Send, Add to queue, the stack): its
 * reference, then its whole stored record after "Here is the complete YAML of
 * the todo:" — the block a todo iteration appends (`todoYamlBlock`,
 * src/utils/todoIterationRecord.ts), so Execute TODO, Guide me and Explain
 * TODO get the same todo a walk gets. `recordBlock` is that block (escaped
 * against the placeholder passes).
 */
export function todoSendBlock(ref: string, recordBlock: string): string {
    return `Todo \`${ref}\`.\n\n${recordBlock}`;
}

/**
 * Build the combined prompt body for a STACK of todos sent as one message.
 *
 * Each fragment is one todo's {@link todoSendBlock}; they follow each other,
 * separated by a blank line. The `REQUIRED responseValue`
 * footer gets one line per todo; keys must be DISTINCT so the answer scanner
 * can resolve each todo separately — a single todo keeps the classic `#TODO=`
 * key, multiple todos use `#TODO_1=`, `#TODO_2=`, … in stack order.
 *
 * Pure so it can be unit tested; the handler feeds it the fragments it built
 * with `_todoPromptFragment` and routes the result through the same template
 * embedding (`${originalPrompt}` / `${userMessage}`) as a single todo.
 */
export function buildStackedTodoPrompt(fragments: StackedTodoFragment[]): string {
    const yamlBlock = fragments.map((f) => f.yaml.trim()).join('\n\n');
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
 * It offers the one template store, the Anthropic user-message templates.
 *
 * "Run default" comes first and is preselected: the item gets no template of
 * its own and takes its run's default template when it is sent (a direct send
 * looks it up then); its label names the run's template now.
 *
 * @param runDefaultTemplateId  The run's default template (its queue settings),
 *   for the "Run default" label only.
 */
export function buildTodoSendTemplateChoices(
    transport: TodoSendTransport,
    config: TodoTemplateSourceConfig | undefined,
    runDefaultTemplateId?: string,
): TodoSendTemplateChoices {
    const userTemplates = config?.anthropic?.userMessageTemplates ?? [];
    const runTemplate = runDefaultTemplateId ? (userTemplates.find((t) => t.id === runDefaultTemplateId)?.name || runDefaultTemplateId) : undefined;
    const templates: TodoTemplateOption[] = [
        { id: RUN_DEFAULT_CHOICE, label: runDefaultLabel(runTemplate, 'no template') },
        { id: '__none__', label: '(None)' },
        ...userTemplates.map((t) => ({ id: t.id, label: t.name || t.id })),
    ];
    return { transport, templates, selected: RUN_DEFAULT_CHOICE };
}
