/**
 * The templates of a Copilot send.
 *
 * There is one template store, the Anthropic user-message templates
 * (`anthropic.userMessageTemplates`, body with `${userMessage}`; an
 * `${originalPrompt}` in a body is filled the same way). A Copilot send that
 * names a template takes it from there, by id or name.
 *
 * The **Copilot Queue Wrapper** (`copilot.queueWrapper`, body with
 * `${originalPrompt}`; default {@link DEFAULT_ANSWER_FILE_TEMPLATE}) makes
 * Copilot write an answer file — how the queue and `tomAi_askCopilot` know the
 * answer has come. It goes around every Copilot send that waits for an answer:
 * a queue item's stages (unless the item sets `answerWrapper: false`, waiting a
 * fixed time instead), the todo panel's buttons and `tomAi_askCopilot`. The
 * Copilot panel's own Send wraps only when its Wrap checkbox is on.
 *
 * The template id `__answer_file__` (the wrapper's entry in the former
 * `copilot.templates`) still means "no template, wrapped", so a queued item
 * that names it keeps working. vscode-free.
 */

/** The template id that selects "no template, wrapped". */
export const ANSWER_WRAPPER_ID = '__answer_file__';

/** The default Copilot Queue Wrapper. Placeholders: `${originalPrompt}`, `${copilotAnswerFile}`, `${requestId}`. */
export const DEFAULT_ANSWER_FILE_TEMPLATE =
    `\${originalPrompt}\n\n---\nAFTER completing your response, create a JSON answer file at exactly this path:\n\${copilotAnswerFile}\n\nThe file must contain valid JSON matching this schema:\n\`\`\`json\n{\n  "requestId": "\${requestId}",\n  "generatedMarkdown": "<your full response as a JSON-escaped string>",\n  "comments": "<short summary of what you did (optional)>",\n  "references": ["<workspace-relative paths of files you referenced (optional)>"],\n  "requestedAttachments": ["<workspace-relative paths the user asked you to provide (optional)>"],\n  "responseValues": { "<key>": "<value>" }\n}\n\`\`\`\nRules:\n- generatedMarkdown: REQUIRED — your complete response text, JSON-escaped (newlines as \\n, quotes as \\\")\n- responseValues: key-value pairs accessible in later prompts via \\\${chat.<key>}\n- The user may request specific responseValues using #key=description notation in the prompt (e.g. #errorCount=number of errors). For each such marker, include the key with the computed value in responseValues.\n- Create the file using your file-creation tool — do NOT ask for confirmation\n- Request ID for this prompt: \${requestId}\n`;

/** The config slice these helpers read. */
export interface CopilotTemplateSource {
    copilot?: { queueWrapper?: unknown };
    anthropic?: { userMessageTemplates?: Array<{ id?: string; name?: string; template?: string }> };
}

/** The Copilot Queue Wrapper body: the configured one, else the default. */
export function copilotQueueWrapper(config: CopilotTemplateSource | null | undefined): string {
    const own = config?.copilot?.queueWrapper;
    return typeof own === 'string' && own.trim() ? own : DEFAULT_ANSWER_FILE_TEMPLATE;
}

/** A user-message template's body by id (or name); undefined for none, `(None)`, `__none__` and the wrapper id. */
export function userMessageTemplateBody(config: CopilotTemplateSource | null | undefined, idOrName: string | undefined): string | undefined {
    if (!idOrName || idOrName === '(None)' || idOrName === '__none__' || idOrName === ANSWER_WRAPPER_ID) { return undefined; }
    const match = (config?.anthropic?.userMessageTemplates ?? []).find((t) => t && (t.id === idOrName || t.name === idOrName));
    return typeof match?.template === 'string' ? match.template : undefined;
}

/** The user-message templates as dropdown options `{id, label}`. */
export function userMessageTemplateOptions(config: CopilotTemplateSource | null | undefined): Array<{ id: string; label: string }> {
    return (config?.anthropic?.userMessageTemplates ?? [])
        .filter((t) => t && typeof t.id === 'string' && t.id)
        .map((t) => ({ id: t.id as string, label: t.name || (t.id as string) }));
}

/** Put `text` into a template body (`${userMessage}` and `${originalPrompt}`). */
export function fillTemplate(body: string, text: string): string {
    return body.replace(/\$\{userMessage\}/g, () => text).replace(/\$\{originalPrompt\}/g, () => text);
}

/** Put `text` into the wrapper (`${originalPrompt}`). */
export function fillWrapper(wrapper: string, text: string): string {
    return wrapper.replace(/\$\{originalPrompt\}/g, () => text);
}

/**
 * The format migration's step for version 6: the config without
 * `copilot.templates` and `copilot.defaultTemplate`. Nothing of the
 * templates is copied; only an own Answer Wrapper (the `__answer_file__`
 * entry, when it differs from the default) becomes `copilot.queueWrapper`,
 * unless one is set already. Answers what was done ([] when nothing).
 */
export function dropCopilotTemplates(config: unknown): string[] {
    const copilot = (config as { copilot?: unknown } | null)?.copilot;
    if (!copilot || typeof copilot !== 'object') { return []; }
    const c = copilot as Record<string, unknown>;
    const done: string[] = [];
    const templates = c.templates;
    if (templates !== undefined) {
        const wrapper = (templates as Record<string, { template?: unknown }> | null)?.[ANSWER_WRAPPER_ID]?.template;
        const own = typeof wrapper === 'string' && wrapper.trim() && wrapper !== DEFAULT_ANSWER_FILE_TEMPLATE ? wrapper : undefined;
        if (own !== undefined && c.queueWrapper === undefined) {
            c.queueWrapper = own;
            done.push('the own Answer Wrapper as copilot.queueWrapper');
        }
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
