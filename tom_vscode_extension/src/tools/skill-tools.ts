/**
 * `tomAi_loadSkill` — Claude Code's skills for the transports that run our own
 * tool loop (direct, Local LLM, VS Code LM; CC-10 (a)). The system prompt
 * names every skill with its description (services/skills.ts); this tool
 * returns one skill's SKILL.md, its folder, its allowed tools and its files.
 * The Agent SDK keeps its own Skill tool, so there this one is a duplicate of
 * a Claude Code built-in.
 */

import * as vscode from 'vscode';
import { SharedToolDefinition } from './shared-tool-registry';
import { LOAD_SKILL_TOOL_NAME, loadSkillImpl, type LoadSkillInput } from '../services/skills';

export const LOAD_SKILL_DESCRIPTION =
    'Load a skill — a task guide kept in `.claude/skills/<name>/SKILL.md` (the workspace\'s own and its parent ' +
    'folders\'; the system prompt lists them with their descriptions). Returns the skill\'s folder, the tools its ' +
    'frontmatter allows, the files beside it (read them with `tomAi_readFile`) and the whole SKILL.md. Call it before ' +
    'doing a task a skill\'s description matches, and follow the skill. An unknown name answers the skills there are.';

export const LOAD_SKILL_TOOL: SharedToolDefinition<LoadSkillInput> = {
    name: LOAD_SKILL_TOOL_NAME,
    displayName: 'Load Skill',
    description: LOAD_SKILL_DESCRIPTION,
    tags: ['skills', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'The skill\'s name, as the system prompt lists it (its folder name). Example: `review-pr`.' },
        },
        required: ['name'],
    },
    execute: (input) => loadSkillImpl(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SKILL_TOOLS: SharedToolDefinition<any>[] = [
    LOAD_SKILL_TOOL,
];
