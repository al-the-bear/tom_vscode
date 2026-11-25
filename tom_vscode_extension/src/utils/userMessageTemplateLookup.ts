/**
 * The user-message templates: the one template store
 * (`anthropic.userMessageTemplates`, body with `${userMessage}`; an
 * `${originalPrompt}` in a body is filled the same way), looked up by id or
 * name.
 *
 * The template id `__answer_file__` (a stored value of older queue items and
 * timed requests) means "no template". vscode-free.
 */

import { liveUserMessageTemplateId } from './userMessageTemplateSeeds';

/** A stored template id that means "no template". */
export const ANSWER_WRAPPER_ID = '__answer_file__';

/** The config slice these helpers read. */
export interface UserMessageTemplateSource {
    anthropic?: { userMessageTemplates?: Array<{ id?: string; name?: string; template?: string }> };
}

/** A user-message template's body by id (or name); undefined for none, `(None)`, `__none__` and the wrapper id. */
export function userMessageTemplateBody(config: UserMessageTemplateSource | null | undefined, idOrName: string | undefined): string | undefined {
    if (!idOrName || idOrName === '(None)' || idOrName === '__none__' || idOrName === ANSWER_WRAPPER_ID) { return undefined; }
    // A retired template (with-context, with-role-banner; vscimpb120) resolves to default-raw.
    const wanted = liveUserMessageTemplateId(idOrName);
    const match = (config?.anthropic?.userMessageTemplates ?? []).find((t) => t && (t.id === wanted || t.name === wanted));
    return typeof match?.template === 'string' ? match.template : undefined;
}

/** The user-message templates as dropdown options `{id, label}`. */
export function userMessageTemplateOptions(config: UserMessageTemplateSource | null | undefined): Array<{ id: string; label: string }> {
    return (config?.anthropic?.userMessageTemplates ?? [])
        .filter((t) => t && typeof t.id === 'string' && t.id)
        .map((t) => ({ id: t.id as string, label: t.name || (t.id as string) }));
}

/** Put `text` into a template body (`${userMessage}` and `${originalPrompt}`). */
export function fillTemplate(body: string, text: string): string {
    return body.replace(/\$\{userMessage\}/g, () => text).replace(/\$\{originalPrompt\}/g, () => text);
}

/**
 * The format migration's step for version 6: the config without
 * `copilot.templates` and `copilot.defaultTemplate`. Nothing of the
 * templates is copied. Answers what was done ([] when nothing).
 */
export function dropCopilotTemplates(config: unknown): string[] {
    const copilot = (config as { copilot?: unknown } | null)?.copilot;
    if (!copilot || typeof copilot !== 'object') { return []; }
    const c = copilot as Record<string, unknown>;
    const done: string[] = [];
    const templates = c.templates;
    if (templates !== undefined) {
        const count = templates && typeof templates === 'object' ? Object.keys(templates).filter((k) => k !== ANSWER_WRAPPER_ID).length : 0;
        delete c.templates;
        done.push(`remove copilot.templates (${count} template(s), not copied)`);
    }
    if (c.defaultTemplate !== undefined) {
        delete c.defaultTemplate;
        done.push('remove copilot.defaultTemplate');
    }
    return done;
}
