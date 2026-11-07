/**
 * Pure rules of the "Send to Anthropic/LLM" commands (`tomAi.sendToLlm*`,
 * src/handlers/sendToLlm-handler.ts): which text of the editor is sent, and
 * which user-message templates there are to pick from.
 */

/** How a variant takes its text: `selection` needs one; `selectionOrDocument` sends the whole file without one. */
export type LlmSendTextMode = 'selection' | 'selectionOrDocument';

/** One user-message template of the one template store (`anthropic.userMessageTemplates`). */
export interface LlmTemplateChoice {
    id: string;
    label: string;
    template: string;
    isDefault: boolean;
}

/** The text a send takes, or why there is none. */
export function llmSendText(selectionText: string, documentText: string, mode: LlmSendTextMode): { text: string } | { error: string } {
    if (selectionText.trim()) { return { text: selectionText }; }
    if (mode === 'selection') { return { error: 'No text selected.' }; }
    if (documentText.trim()) { return { text: documentText }; }
    return { error: 'The file is empty.' };
}

/** The templates of `anthropic.userMessageTemplates` that can be sent with, in their order; entries without an id or body are left out. */
export function llmTemplateChoices(templates: unknown): LlmTemplateChoice[] {
    if (!Array.isArray(templates)) { return []; }
    const out: LlmTemplateChoice[] = [];
    for (const t of templates as Array<Record<string, unknown>>) {
        if (!t || typeof t.id !== 'string' || !t.id || typeof t.template !== 'string') { continue; }
        out.push({
            id: t.id,
            label: typeof t.name === 'string' && t.name ? t.name : t.id,
            template: t.template,
            isDefault: t.isDefault === true,
        });
    }
    return out;
}
