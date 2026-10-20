/**
 * The escape for a literal placeholder. vscode-free, so tools that are can use it.
 */

/**
 * A literal placeholder: `$${name}` (and `$${{expr}}`) is left as written by
 * every resolution pass — however often a text is resolved on its way (a
 * Proceed prompt is resolved when queued, again when sent, again when wrapped
 * for the transport) — and becomes `${name}` only here, where the text leaves
 * for the model: the Anthropic system prompt and user message, the Copilot
 * dispatch, and tool answers that show what the system prompt shows. A process
 * description or step prompt can so show `${repeatTodoId}` to the agent, who
 * writes it into the item it queues.
 */
export function unescapePlaceholders(text: string): string {
    return text.replace(/\$\$\{/g, '${');
}
