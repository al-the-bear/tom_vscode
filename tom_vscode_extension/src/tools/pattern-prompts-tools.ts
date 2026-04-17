/**
 * Pattern-prompt tools.
 *
 * Pattern prompts are workspace-level instruction files stored under
 * `_copilot_guidelines/pattern_prompts/` (fallback: `_copilot_tomai/pattern_prompts/`).
 * The user invokes them in chat via `!<name>` (e.g. `!continue`, `!commit`),
 * and the extension substitutes the file content before sending the prompt.
 *
 * These tools let an LLM discover and read those files directly so the model
 * can follow the canonical instructions for a named workflow.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

const PATTERN_SUBDIRS: ReadonlyArray<string> = [
    '_copilot_guidelines/pattern_prompts',
    '_copilot_tomai/pattern_prompts',
];

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolvePatternPromptsDirs(): string[] {
    const root = wsRoot();
    if (!root) { return []; }
    return PATTERN_SUBDIRS
        .map((sub) => path.join(root, sub))
        .filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
}

function normalizePromptName(name: string): string {
    let n = name.trim();
    if (n.startsWith('!')) { n = n.slice(1); }
    if (n.endsWith('.md')) { n = n.slice(0, -3); }
    return n;
}

// ---------------------------------------------------------------------------
// tomAi_listPatternPrompts
// ---------------------------------------------------------------------------

interface ListPatternPromptsInput {
    // no params
}

async function executeListPatternPrompts(_input: ListPatternPromptsInput): Promise<string> {
    const dirs = resolvePatternPromptsDirs();
    if (dirs.length === 0) {
        return JSON.stringify({ error: 'No pattern_prompts folder found under _copilot_guidelines/ or _copilot_tomai/.' });
    }
    const seen = new Map<string, { name: string; invocation: string; source: string; size: number }>();
    for (const dir of dirs) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith('.md')) { continue; }
            const name = e.name.slice(0, -3);
            if (seen.has(name)) { continue; }
            let size = 0;
            try { size = fs.statSync(path.join(dir, e.name)).size; } catch { /* ignore */ }
            const root = wsRoot() || '';
            seen.set(name, {
                name,
                invocation: `!${name}`,
                source: path.relative(root, path.join(dir, e.name)),
                size,
            });
        }
    }
    const prompts = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify({
        count: prompts.length,
        prompts,
        note: 'Pattern prompts are invoked in chat with `!<name>` (e.g. `!continue`). Use tomAi_readPatternPrompt to fetch the body.',
    }, null, 2);
}

export const LIST_PATTERN_PROMPTS_TOOL: SharedToolDefinition<ListPatternPromptsInput> = {
    name: 'tomAi_listPatternPrompts',
    displayName: 'List Pattern Prompts',
    description:
        'List the available workspace pattern prompts (files invoked via `!<name>` in chat). ' +
        'Pattern prompts live under `_copilot_guidelines/pattern_prompts/` or `_copilot_tomai/pattern_prompts/`.',
    tags: ['patternPrompts', 'guidelines', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: executeListPatternPrompts,
};

// ---------------------------------------------------------------------------
// tomAi_readPatternPrompt
// ---------------------------------------------------------------------------

interface ReadPatternPromptInput { name: string }

async function executeReadPatternPrompt(input: ReadPatternPromptInput): Promise<string> {
    if (!input.name) { return JSON.stringify({ error: 'name is required (e.g. "continue" or "!continue").' }); }
    const normalized = normalizePromptName(input.name);
    if (!normalized) { return JSON.stringify({ error: 'name resolves to an empty string' }); }
    const dirs = resolvePatternPromptsDirs();
    for (const dir of dirs) {
        const file = path.join(dir, `${normalized}.md`);
        if (fs.existsSync(file)) {
            try {
                const content = fs.readFileSync(file, 'utf8');
                const root = wsRoot() || '';
                return JSON.stringify({
                    name: normalized,
                    invocation: `!${normalized}`,
                    source: path.relative(root, file),
                    content,
                });
            } catch (err: any) {
                return JSON.stringify({ error: `Read failed: ${err?.message ?? err}` });
            }
        }
    }
    return JSON.stringify({
        error: `Pattern prompt not found: "${normalized}". Use tomAi_listPatternPrompts to see what's available.`,
    });
}

export const READ_PATTERN_PROMPT_TOOL: SharedToolDefinition<ReadPatternPromptInput> = {
    name: 'tomAi_readPatternPrompt',
    displayName: 'Read Pattern Prompt',
    description:
        'Read the body of a workspace pattern prompt by name. Accepts "continue", "!continue", or "continue.md".',
    tags: ['patternPrompts', 'guidelines', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string', description: 'Prompt name (with or without the leading `!` and `.md`).' },
        },
    },
    execute: executeReadPatternPrompt,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PATTERN_PROMPTS_TOOLS: SharedToolDefinition<any>[] = [
    LIST_PATTERN_PROMPTS_TOOL,
    READ_PATTERN_PROMPT_TOOL,
];
