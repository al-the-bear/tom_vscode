/**
 * Claude Code's subagent definitions for every transport (CC-11 (a)).
 *
 * A definition is `.claude/agents/<name>.md`: YAML frontmatter (`name`,
 * `description`, `tools` — a list or a comma-separated string, `model` — an
 * alias such as `sonnet`, a model id or `inherit`) and a Markdown body, the
 * agent's system prompt. They are found like skills: the workspace's own
 * `.claude/agents/` and every parent folder's, the nearest of a name winning.
 *
 * Two consumers:
 * - `tomAi_spawnSubagent {agent}` on our own loop (direct, Local LLM, VS Code
 *   LM — and the Agent SDK through our MCP server): the body is the system
 *   prompt, the tools are mapped to ours ({@link toOurToolNames}), the model
 *   picks a configuration ({@link resolveSubagentConfiguration});
 * - the Agent SDK's `agents` option ({@link toSdkAgents}), so its own Task
 *   tool can delegate to them.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import { claudeDirsUpward, firstProseLine, frontmatterList, frontmatterString, splitFrontmatter } from './claudeDirs';

/** Our MCP server's name on the Agent SDK: its tools are `mcp__<server>__<tool>` there. */
const OWN_MCP_PREFIX = 'mcp__tom-ai__';

export interface AgentDefinitionInfo {
    name: string;
    description: string;
    /** The frontmatter's `tools` as written; undefined when it states none. */
    tools?: string[];
    /** The frontmatter's `model`; undefined when it states none. */
    model?: string;
    /** The body: the agent's system prompt. */
    prompt: string;
    /** Absolute path of the definition file. */
    file: string;
    /** True when it lives in the workspace's own `.claude/agents/`. */
    direct: boolean;
}

function readDefinition(file: string, direct: boolean): AgentDefinitionInfo | undefined {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
    const { meta, body } = splitFrontmatter(text);
    const prompt = body.trim();
    return {
        name: frontmatterString(meta.name) ?? path.basename(file, '.md'),
        description: frontmatterString(meta.description) ?? firstProseLine(prompt),
        tools: frontmatterList(meta.tools),
        model: frontmatterString(meta.model),
        prompt,
        file,
        direct,
    };
}

/** Every definition visible from the workspace: its own first, each folder's by name. */
export function listAgentDefinitions(wsRoot: string): AgentDefinitionInfo[] {
    const byName = new Map<string, AgentDefinitionInfo>();
    for (const { dir, direct } of claudeDirsUpward(wsRoot, 'agents')) {
        let names: string[];
        try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort(); } catch { continue; }
        for (const fileName of names) {
            const def = readDefinition(path.join(dir, fileName), direct);
            // The nearest definition of a name wins.
            if (def && !byName.has(def.name)) { byName.set(def.name, def); }
        }
    }
    return [...byName.values()];
}

export function findAgentDefinition(wsRoot: string, name: string): AgentDefinitionInfo | undefined {
    return listAgentDefinitions(wsRoot).find((d) => d.name === name);
}

/** Claude Code's built-in tools and their equivalents in our tool set. */
/* eslint-disable @typescript-eslint/naming-convention -- Claude Code's tool names */
export const CLAUDE_CODE_TOOL_EQUIVALENTS: Readonly<Record<string, string>> = {
    Read: 'tomAi_readFile',
    Write: 'tomAi_createFile',
    Edit: 'tomAi_editFile',
    MultiEdit: 'tomAi_multiEditFile',
    Glob: 'tomAi_findFiles',
    Grep: 'tomAi_findTextInFiles',
    LS: 'tomAi_listDirectory',
    Bash: 'tomAi_runCommand',
    WebFetch: 'tomAi_fetchWebpage',
    WebSearch: 'tomAi_webSearch',
    NotebookEdit: 'tomAi_notebookEdit',
};
/* eslint-enable @typescript-eslint/naming-convention */

/** A definition's tool names as our tool names; `unknown` holds the ones without an equivalent. */
export function toOurToolNames(tools: readonly string[]): { names: string[]; unknown: string[] } {
    const names: string[] = [];
    const unknown: string[] = [];
    for (const tool of tools) {
        const bare = tool.startsWith(OWN_MCP_PREFIX) ? tool.slice(OWN_MCP_PREFIX.length) : tool;
        const ours = bare.startsWith('tomAi_') ? bare : CLAUDE_CODE_TOOL_EQUIVALENTS[bare];
        if (ours) {
            if (!names.includes(ours)) { names.push(ours); }
        } else {
            unknown.push(tool);
        }
    }
    return { names, unknown };
}

/** The SDK's AgentDefinition, as far as a definition file fills it. */
export interface SdkAgentDefinition {
    description: string;
    prompt: string;
    tools?: string[];
    model?: string;
}

/**
 * The Agent SDK's `agents` option: our tools under their MCP names, the
 * built-ins as written; no `tools` when the definition states none (the SDK
 * then gives the agent every tool of the parent).
 */
export function toSdkAgents(defs: readonly AgentDefinitionInfo[]): Record<string, SdkAgentDefinition> {
    const out: Record<string, SdkAgentDefinition> = {};
    for (const def of defs) {
        out[def.name] = {
            description: def.description,
            prompt: def.prompt,
            ...(def.model ? { model: def.model } : {}),
            ...(def.tools ? { tools: def.tools.map((t) => (t.startsWith('tomAi_') ? `${OWN_MCP_PREFIX}${t}` : t)) } : {}),
        };
    }
    return out;
}

/** The fields of an Anthropic configuration the choice reads. */
export interface ConfigurationLike {
    model: string;
    transport?: string;
    isDefault?: boolean;
}

/** The transports that take any Anthropic model id. */
const ANTHROPIC_MODEL_TRANSPORTS = new Set(['direct', 'agentSdk', undefined]);

/**
 * The configuration a sub-agent with `model` runs on. None or `inherit`: the
 * default (the configuration marked default, else the first). Otherwise the
 * configuration whose model is that id or contains that alias (`sonnet` in
 * `claude-sonnet-5-5`), one on the default's transport first. No match: an id
 * (`claude-…`) runs on the default with that model when the default takes
 * Anthropic ids (direct, Agent SDK); anything else runs on the default as it
 * is, with a `note` saying so.
 */
export function resolveSubagentConfiguration<C extends ConfigurationLike>(
    configurations: readonly C[],
    model: string | undefined,
): { configuration: C; note?: string } {
    const fallback = configurations.find((c) => c.isDefault) ?? configurations[0];
    if (!fallback) {
        throw new Error('No Anthropic configuration is available. Add at least one in the Status page before spawning a sub-agent.');
    }
    if (!model || model === 'inherit') { return { configuration: fallback }; }
    const wanted = model.toLowerCase();
    const matches = (c: C): boolean => {
        const m = c.model.toLowerCase();
        return m === wanted || (!wanted.includes('-') && m.split(/[-_.:/]/).includes(wanted));
    };
    const sameTransport = configurations.find((c) => matches(c) && (c.transport ?? 'direct') === (fallback.transport ?? 'direct'));
    const any = sameTransport ?? configurations.find(matches);
    if (any) { return { configuration: any }; }
    if (wanted.startsWith('claude-') && ANTHROPIC_MODEL_TRANSPORTS.has(fallback.transport)) {
        return { configuration: { ...fallback, model } };
    }
    return {
        configuration: fallback,
        note: `No configuration has the model "${model}"; the sub-agent ran on ${fallback.model}.`,
    };
}
