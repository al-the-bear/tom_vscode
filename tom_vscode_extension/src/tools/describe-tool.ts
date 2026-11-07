/**
 * tomAi_describeTool (DA-17 (a)): a tool's full description, every argument
 * and its documentation in doc/llm_tools.md. Tool descriptions are kept short
 * (purpose, arguments, the one trap — a test caps their length); this is where
 * an agent reads the rest, the same way on every transport.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { SharedToolDefinition } from './shared-tool-registry';
import { toolArguments, toolDocumentation } from '../utils/toolDocs';

/** The bundled tool documentation: `doc/llm_tools.md` of the extension (out/tools/ → ../../doc/). */
export const TOOL_DOC_PATH = path.join(__dirname, '..', '..', 'doc', 'llm_tools.md');

export interface DescribeToolInput {
    name: string;
}

export interface DescribeToolDeps {
    tools(): ReadonlyArray<SharedToolDefinition<unknown>>;
    readDoc(): string | undefined;
}

export function describeToolImpl(deps: DescribeToolDeps, input: DescribeToolInput): string {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name) { return JSON.stringify({ ok: false, error: '`name` is required: a tool name such as tomAi_createQuestTodo.' }); }
    const all = deps.tools();
    const tool = all.find((t) => t.name === name) ?? all.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!tool) {
        const near = all.map((t) => t.name).filter((n) => n.toLowerCase().includes(name.toLowerCase().replace(/^tomai_/, ''))).slice(0, 10);
        return JSON.stringify({ ok: false, error: `No tool named "${name}".`, ...(near.length ? { similar: near } : {}) });
    }
    const doc = deps.readDoc();
    const found = doc ? toolDocumentation(doc, tool.name) : { section: '', mentions: [] };
    return JSON.stringify({
        ok: true,
        name: tool.name,
        displayName: tool.displayName,
        readOnly: tool.readOnly === true,
        requiresApproval: tool.requiresApproval === true,
        description: tool.description,
        arguments: toolArguments(tool.inputSchema),
        documentation: found.section || null,
        mentions: found.mentions,
        ...(doc === undefined ? { docMissing: TOOL_DOC_PATH } : {}),
    });
}

export const DESCRIBE_TOOL_TOOL: SharedToolDefinition<DescribeToolInput> = {
    name: 'tomAi_describeTool',
    displayName: 'Describe Tool',
    description:
        'Everything about one tool: its full description, every argument (type, required, description, enum) and its '
        + 'documentation in the extension\'s doc/llm_tools.md (`documentation`: its own section, when it has one; `mentions`: '
        + 'every other line naming it). Use it when a tool\'s short description leaves a question open. Read-only.',
    tags: ['tools', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string', description: 'The tool name, e.g. `tomAi_createQuestTodo`.' },
        },
    },
    execute: async (input) => describeToolImpl(liveDescribeDeps(), input),
};

function liveDescribeDeps(): DescribeToolDeps {
    return {
        tools: () => {
            // Loaded at call time: tool-executors imports this module.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { ALL_SHARED_TOOLS } = require('./tool-executors') as typeof import('./tool-executors');
            return ALL_SHARED_TOOLS;
        },
        readDoc: () => {
            try { return fs.readFileSync(TOOL_DOC_PATH, 'utf8'); } catch { return undefined; }
        },
    };
}

export const DESCRIBE_TOOL_TOOLS: SharedToolDefinition<any>[] = [DESCRIBE_TOOL_TOOL];
