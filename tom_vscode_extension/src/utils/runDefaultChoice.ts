/**
 * "Run default": a choice in the pickers of the chat panel and the todo panel
 * (profile, session, template, role) that sets nothing on a queue item, so the
 * item takes its run's default when it is sent — change the run's default and
 * every item without a setting of its own follows.
 *
 * - In the webviews and the panel state the choice is {@link RUN_DEFAULT_CHOICE}
 *   (never a valid profile id, session name or template id: those start with a
 *   letter or digit).
 * - A queue item without a profile, transport, session or role of its own
 *   already takes the run's default at send time. The template is different: an
 *   item stores one and the queue builds it into the text, so "Run default" is
 *   stored as {@link RUN_DEFAULT_TEMPLATE} and resolved each time the item's
 *   text is built ({@link resolveItemTemplate}).
 *
 * vscode-free.
 */

/** The picker value of "Run default". */
export const RUN_DEFAULT_CHOICE = '__run_default__';

/** The template value of a queue item that takes its run's default template when it is sent. */
export const RUN_DEFAULT_TEMPLATE = '(Run default)';

/** The template value of an item without a template. */
export const NO_TEMPLATE_VALUE = '(None)';

/** Whether a picker value is "Run default". */
export function isRunDefaultChoice(value: unknown): boolean {
    return value === RUN_DEFAULT_CHOICE;
}

/** Whether an item's template is "Run default" (stored, or the picker value passed through). */
export function isRunDefaultTemplate(template: string | undefined): boolean {
    return template === RUN_DEFAULT_TEMPLATE || template === RUN_DEFAULT_CHOICE;
}

/**
 * The template to build an item's text with: the run's default template for
 * "Run default" (none when the run has none), else the item's own.
 */
export function resolveItemTemplate(template: string | undefined, runDefaultTemplateId: string | undefined): string | undefined {
    if (!isRunDefaultTemplate(template)) { return template; }
    const t = runDefaultTemplateId?.trim();
    return t ? t : NO_TEMPLATE_VALUE;
}

/** A picker's template value as a queue item stores it: "Run default" → {@link RUN_DEFAULT_TEMPLATE}, `__none__` / '' → undefined. */
export function itemTemplateOfChoice(choice: string | undefined): string | undefined {
    if (!choice || choice === '__none__') { return undefined; }
    return isRunDefaultChoice(choice) ? RUN_DEFAULT_TEMPLATE : choice;
}

/** How a queue view names an item's template: "Run default (execute-todo)" for the run's default. */
export function itemTemplateLabel(template: string | undefined, runDefaultTemplateId: string | undefined): string {
    if (!isRunDefaultTemplate(template)) { return template || NO_TEMPLATE_VALUE; }
    const t = runDefaultTemplateId?.trim();
    return `Run default (${t ? t : 'no template'})`;
}

/**
 * A picker's value resolved for a send that runs now (the chat panel's Send):
 * "Run default" becomes the run's value (`whenNone` when the run has none),
 * anything else stays.
 */
export function resolveRunDefaultChoice(value: string | undefined, runValue: string | undefined, whenNone = ''): string {
    if (!isRunDefaultChoice(value)) { return value ?? ''; }
    const v = runValue?.trim();
    return v ? v : whenNone;
}

/** What "Run default" stands for in a picker's label: `Run default (opus)`, `Run default (none)`. */
export function runDefaultLabel(runValue: string | undefined, none = 'none'): string {
    const v = runValue?.trim();
    return `Run default (${v ? v : none})`;
}

/** The chat panel's stored drafts (one entry per subpanel) as far as this module reads them. */
export interface RunDefaultDrafts {
    [section: string]: { profile?: string; userMessageTemplate?: string; [key: string]: unknown } | undefined;
}

/**
 * The one-time switch of the chat panel to "Run default": the Copilot template
 * (stored as the copilot draft's `profile`) and the ANTHROPIC/LLM user-message
 * template become "Run default". Answers a new object; the sections not there stay absent.
 */
export function chatDraftsOnRunDefault<T extends RunDefaultDrafts>(drafts: T): T {
    const out: RunDefaultDrafts = { ...drafts };
    out.copilot = { ...(drafts.copilot ?? {}), profile: RUN_DEFAULT_CHOICE };
    out.anthropic = { ...(drafts.anthropic ?? {}), userMessageTemplate: RUN_DEFAULT_CHOICE };
    return out as T;
}
