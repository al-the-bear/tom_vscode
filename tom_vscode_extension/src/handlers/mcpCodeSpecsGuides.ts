/**
 * The CodeSpecs workflow guides on the standalone MCP server (vsctasb9): what
 * tomAi_specCodeSpecsGuide answers as a tool, an MCP-native client also finds
 * without a tool call —
 *
 * - resources `codespecs-guide://prompt` and `codespecs-guide://mapping`: the
 *   two guides in full (text/markdown);
 * - the resource template `codespecs-guide://{guide}/{section}`: one numbered
 *   section, e.g. `codespecs-guide://prompt/6.2`;
 * - one prompt per stage runbook (`codespecs-next-step`, `codespecs-stage-a`,
 *   …), its arguments filled in and its guide sections appended.
 *
 * Guides are documentation, so they are served whatever the tool set is (the
 * read-only floor included). Nothing is registered when the packaged guides
 * are missing (an extension built without `npm run som:pack`).
 *
 * vscode-free.
 */

import * as fs from 'fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { GUIDES, RUNBOOKS, guideSection, runbookText } from '../services/codespecs-guides';

export const GUIDE_URI_SCHEME = 'codespecs-guide';

/** Register the guides as resources and the runbooks as prompts; the names registered. */
export function registerCodeSpecsGuides(server: McpServer): { resources: string[]; prompts: string[] } {
    const available = GUIDES.filter((g) => fs.existsSync(g.file));
    if (available.length === 0) { return { resources: [], prompts: [] }; }
    const resources: string[] = [];
    for (const g of available) {
        const uri = `${GUIDE_URI_SCHEME}://${g.id}`;
        server.registerResource(`codespecs-guide-${g.id}`, uri, {
            title: g.title,
            description: `${g.summary} (from ${g.source}). One section: ${GUIDE_URI_SCHEME}://${g.id}/<number>.`,
            mimeType: 'text/markdown',
        }, async () => ({ contents: [{ uri, mimeType: 'text/markdown', text: fs.readFileSync(g.file, 'utf8') }] }));
        resources.push(uri);
    }
    server.registerResource('codespecs-guide-section', new ResourceTemplate(`${GUIDE_URI_SCHEME}://{guide}/{section}`, { list: undefined }), {
        title: 'CodeSpecs guide section',
        description: `One numbered section of a CodeSpecs guide (${available.map((g) => g.id).join(', ')}) with its subsections, e.g. ${GUIDE_URI_SCHEME}://prompt/6.2.`,
        mimeType: 'text/markdown',
    }, async (uri, variables) => {
        const g = available.find((x) => x.id === String(variables.guide));
        if (!g) { throw new Error(`Unknown guide "${String(variables.guide)}". Guides: ${available.map((x) => x.id).join(', ')}.`); }
        const s = guideSection(g.file, decodeURIComponent(String(variables.section)));
        if (!s.ok) { throw new Error(s.error); }
        const tail = s.truncated && s.children
            ? `\n\n(Long section: its subsections are ${s.children.map((c) => `${GUIDE_URI_SCHEME}://${g.id}/${c.number}`).join(', ')}.)`
            : '';
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: s.text + tail }] };
    });
    resources.push(`${GUIDE_URI_SCHEME}://{guide}/{section}`);

    const prompts: string[] = [];
    for (const r of RUNBOOKS) {
        // MCP prompt arguments are strings; required ones must be given.
        const shape: Record<string, z.ZodString | z.ZodOptional<z.ZodString>> = {};
        for (const a of r.arguments) {
            shape[a.name] = a.required ? z.string().describe(a.description) : z.string().optional().describe(a.description);
        }
        server.registerPrompt(r.name, { title: r.title, description: r.description, argsSchema: shape }, (args) => {
            const t = runbookText(r.name, args as Record<string, string | undefined>);
            return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: t.ok ? t.text : t.error } }] };
        });
        prompts.push(r.name);
    }
    return { resources, prompts };
}
