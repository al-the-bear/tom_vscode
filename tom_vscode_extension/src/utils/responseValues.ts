/**
 * Shared extraction of TODO / response-value references from free-form answer
 * text. Both the Copilot answer path and the Anthropic answer path emit these
 * references so the extension can mark `*.todo.yaml` entries done and link back
 * to the source (see CLAUDE.md → "Reporting completed TODOs").
 *
 * The same three shapes are accepted everywhere, so this logic lives in one
 * place rather than being duplicated per handler:
 *
 *   1. JSON `"responseValues": { "TODO": "..." }`
 *   2. YAML `responseValues:` block with `key: value` lines
 *   3. `variables:` block with `- key = value` (or `- key: value`) lines
 *
 * Why a single util: the trail viewer parses answer files written by the trail
 * service, the Anthropic handler parses the model's own answer text, and the
 * todo-log panel reads the persisted `variables:` block — all three must agree
 * on what a "response value" looks like.
 */

/**
 * Parse every response value found in `text`, scanning all three accepted
 * shapes. Later shapes override earlier ones for a repeated key, matching the
 * historical behaviour of the trail viewer.
 */
export function extractResponseValuesFromText(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!text) { return out; }

    const jsonResponseBlock = text.match(/"responseValues"\s*:\s*\{([\s\S]*?)\}/i);
    if (jsonResponseBlock?.[1]) {
        const pairRegex = /"([^"]+)"\s*:\s*"([^"]*)"/g;
        let match: RegExpExecArray | null;
        while ((match = pairRegex.exec(jsonResponseBlock[1])) !== null) {
            const key = (match[1] || '').trim();
            const value = (match[2] || '').trim();
            if (key && value) { out[key] = value; }
        }
    }

    const yamlResponseValuesRegex = /^\s*responseValues\s*:\s*$(?:\n^\s{2,}[^\n]+)+/im;
    const yamlResponseBlock = text.match(yamlResponseValuesRegex);
    if (yamlResponseBlock?.[0]) {
        const lines = yamlResponseBlock[0].split(/\r?\n/);
        for (const line of lines.slice(1)) {
            const pair = line.match(/^\s{2,}([A-Za-z0-9_.-]+)\s*:\s*(.+)\s*$/);
            if (!pair) { continue; }
            const key = pair[1].trim();
            const value = pair[2].trim().replace(/^['"]|['"]$/g, '');
            if (key && value) { out[key] = value; }
        }
    }

    const variablesBlockRegex = /^\s*variables\s*:\s*$(?:\n^\s*[-*]\s*[^\n]+)+/im;
    const variablesBlock = text.match(variablesBlockRegex);
    if (variablesBlock?.[0]) {
        const lines = variablesBlock[0].split(/\r?\n/);
        for (const line of lines.slice(1)) {
            const eqPair = line.match(/^\s*[-*]\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)\s*$/);
            if (eqPair) {
                const key = eqPair[1].trim();
                const value = eqPair[2].trim().replace(/^['"]|['"]$/g, '');
                if (key && value) { out[key] = value; }
                continue;
            }
            const colonPair = line.match(/^\s*[-*]\s*([A-Za-z0-9_.-]+)\s*:\s*(.+)\s*$/);
            if (colonPair) {
                const key = colonPair[1].trim();
                const value = colonPair[2].trim().replace(/^['"]|['"]$/g, '');
                if (key && value) { out[key] = value; }
            }
        }
    }

    return out;
}

/**
 * Best-effort single TODO reference from loosely-structured text — the fallback
 * used when no structured `responseValues` block is present.
 */
export function extractTodoRefFromText(text: string): string | undefined {
    if (!text) { return undefined; }
    const patterns = [
        /"TODO"\s*:\s*"([^"]+)"/i,
        /responseValues\.[Tt][Oo][Dd][Oo]\s*[:=]\s*"?([^"\n]+)"?/i,
        /\bTODO\b\s*[:=]\s*"?([^"\n]+)"?/i,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            const value = match[1].trim();
            if (value) { return value; }
        }
    }
    return undefined;
}

/**
 * Return only the response values whose key contains the uppercase substring
 * `TODO` — the subset that references a `*.todo.yaml` entry. Preserves the key
 * so callers can report several TODOs from one answer.
 */
export function extractTodoResponseValues(text: string): Record<string, string> {
    const all = extractResponseValuesFromText(text);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(all)) {
        if (key.includes('TODO')) { out[key] = value; }
    }
    return out;
}
