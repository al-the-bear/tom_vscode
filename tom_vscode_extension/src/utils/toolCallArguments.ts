/**
 * Tool-call arguments as the Local LLM transport receives them, turned into
 * the object a tool takes (vscimpb69).
 *
 * OpenAI-compatible servers send `function.arguments` as a JSON string, Ollama
 * usually as an object. Some models (ERNIE on Baidu Qianfan, smaller local
 * models) wrap the JSON in a Markdown code fence, put text around it, or
 * encode it twice. In that order of tolerance:
 *
 *   1. an object (not an array) is taken as it is;
 *   2. an empty or blank string is `{}` (a call without arguments);
 *   3. plain JSON of an object;
 *   4. a code fence (```` ```json … ``` ```` or ```` ``` … ``` ````) removed first;
 *   5. a JSON string that itself holds the object's JSON (double-encoded),
 *      decoded once more;
 *   6. the outermost `{ … }` of text around it;
 *
 * and only what none of these reads becomes `{ _raw: <text> }`, reported
 * through `log` with the tool name, so the tool's refusal can be traced.
 */

/** How the arguments were read. */
export type ToolArgumentsRead = 'object' | 'empty' | 'json' | 'fenced' | 'doubleEncoded' | 'extracted' | 'raw';

export interface ParsedToolArguments {
    args: Record<string, unknown>;
    read: ToolArgumentsRead;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `text` as JSON of an object, also when it is a JSON string holding that JSON; else null. */
function objectFromJson(text: string): { args: Record<string, unknown>; doubleEncoded: boolean } | null {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return null; }
    if (isObject(value)) { return { args: value, doubleEncoded: false }; }
    if (typeof value === 'string') {
        try {
            const inner: unknown = JSON.parse(value.trim());
            if (isObject(inner)) { return { args: inner, doubleEncoded: true }; }
        } catch { /* not double-encoded */ }
    }
    return null;
}

/** The body of the first Markdown code fence in `text`, or null. */
function fenceBody(text: string): string | null {
    const m = /```[\w-]*[^\S\r\n]*\r?\n?([\s\S]*?)\r?\n?[^\S\r\n]*```/.exec(text);
    return m ? m[1].trim() : null;
}

/**
 * The arguments of a tool call as an object. `log` receives one line for
 * arguments that could not be read (the `{ _raw }` case), naming the tool.
 */
export function parseToolArguments(raw: unknown, toolName: string, log?: (line: string) => void): ParsedToolArguments {
    if (isObject(raw)) { return { args: raw, read: 'object' }; }
    if (raw === undefined || raw === null) { return { args: {}, read: 'empty' }; }
    const text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
    if (text === '') { return { args: {}, read: 'empty' }; }

    const plain = objectFromJson(text);
    if (plain) { return { args: plain.args, read: plain.doubleEncoded ? 'doubleEncoded' : 'json' }; }

    const fenced = fenceBody(text);
    if (fenced !== null) {
        const inFence = objectFromJson(fenced);
        if (inFence) { return { args: inFence.args, read: inFence.doubleEncoded ? 'doubleEncoded' : 'fenced' }; }
    }

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        const extracted = objectFromJson(text.slice(start, end + 1));
        if (extracted) { return { args: extracted.args, read: 'extracted' }; }
    }

    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    log?.(`[toolArguments] ${toolName || '(unnamed tool)'}: arguments are not a JSON object; the tool receives { _raw }: ${preview}`);
    return { args: { _raw: typeof raw === 'string' ? raw : text }, read: 'raw' };
}
