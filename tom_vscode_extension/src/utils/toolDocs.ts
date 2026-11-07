/**
 * The documentation of one tool in doc/llm_tools.md, and a tool's arguments
 * read from its input schema — what tomAi_describeTool answers
 * (src/tools/describe-tool.ts).
 *
 * vscode-free.
 */

/** One argument of a tool, as its input schema declares it. */
export interface ToolArgument {
    name: string;
    type: string;
    required: boolean;
    description?: string;
    enum?: unknown[];
    /** The properties of an object argument, the same way. */
    properties?: ToolArgument[];
}

/** The arguments of an input schema: every property with its type, whether it is required, its description and its enum. */
export function toolArguments(schema: unknown): ToolArgument[] {
    const s = schema as { properties?: Record<string, unknown>; required?: unknown } | undefined;
    const props = s?.properties && typeof s.properties === 'object' ? s.properties : {};
    const required = new Set(Array.isArray(s?.required) ? (s!.required as unknown[]).map(String) : []);
    return Object.entries(props).map(([name, raw]) => {
        const p = (raw ?? {}) as { type?: unknown; description?: unknown; enum?: unknown; items?: { type?: unknown; enum?: unknown }; properties?: unknown };
        const type = Array.isArray(p.type)
            ? p.type.map(String).join(' | ')
            : p.type === 'array' && p.items?.type ? `array of ${String(p.items.type)}` : String(p.type ?? 'any');
        const values = Array.isArray(p.enum) ? p.enum : Array.isArray(p.items?.enum) ? p.items!.enum as unknown[] : undefined;
        return {
            name,
            type,
            required: required.has(name),
            ...(typeof p.description === 'string' ? { description: p.description } : {}),
            ...(values ? { enum: values } : {}),
            ...(p.type === 'object' && p.properties ? { properties: toolArguments(p) } : {}),
        };
    });
}

/**
 * What doc/llm_tools.md says about `name`: the section whose heading names
 * the tool (`` `name` `` in a heading, up to the next heading of the same or a
 * higher level), and every other line that names it (table rows, notes), in
 * document order. Empty strings when the document does not mention it.
 */
export function toolDocumentation(markdown: string, name: string): { section: string; mentions: string[] } {
    const lines = markdown.split(/\r?\n/);
    const token = '`' + name + '`';
    const levelOf = (line: string): number => { const m = /^(#{1,6})\s/.exec(line); return m ? m[1].length : 0; };
    let inFence = false;
    let start = -1;
    let level = 0;
    let end = lines.length;
    const fenced: boolean[] = lines.map((line) => {
        if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return true; }
        return inFence;
    });
    for (let i = 0; i < lines.length; i++) {
        if (fenced[i]) { continue; }
        const l = levelOf(lines[i]);
        if (start < 0 && l > 0 && lines[i].includes(token)) { start = i; level = l; continue; }
        if (start >= 0 && l > 0 && l <= level) { end = i; break; }
    }
    const section = start >= 0 ? lines.slice(start, end).join('\n').trim() : '';
    const mentions = lines
        .filter((line, i) => !(start >= 0 && i >= start && i < end) && line.includes(token))
        .map((line) => line.trim());
    return { section, mentions };
}
