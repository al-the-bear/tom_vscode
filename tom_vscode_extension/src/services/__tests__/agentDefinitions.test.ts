/**
 * Claude Code subagent definitions (`.claude/agents/<name>.md`) for every
 * transport (ccparity_d_claudecode-2, CC-11 (a)): services/agentDefinitions.ts.
 *
 *   AD-1 discovery over a fixture workspace: name, description, tools (string or list), model and the body as
 *        the system prompt; the workspace's own first; a nearer definition masks an ancestor's of the same name;
 *        a file without frontmatter is named by its file; non-.md files are no definition
 *   AD-2 tool names for our own loop: our tools stay, `mcp__tom-ai__…` loses its prefix, Claude Code's built-ins
 *        map to their equivalents (Read → tomAi_readFile, Bash → tomAi_runCommand, …), the rest is reported
 *   AD-3 the Agent SDK's `agents` option: description, prompt, model, tools with ours as `mcp__tom-ai__…` and the
 *        built-ins as they are; tools left out when the definition states none (the SDK inherits)
 *   AD-4 the configuration a sub-agent runs on: none / `inherit` → the default; an alias or an id → the
 *        configuration with that model, the default's transport preferred; an id nobody has → the default with
 *        that model on direct / Agent SDK; otherwise the default with a note
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    findAgentDefinition, listAgentDefinitions, resolveSubagentConfiguration, toOurToolNames, toSdkAgents,
} from '../agentDefinitions';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-defs-'));
const ws = path.join(base, 'parent', 'workspace');
const write = (rel: string, text: string): void => {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
};

write('parent/workspace/.claude/agents/reviewer.md', [
    '---',
    'name: reviewer',
    'description: Reviews a diff against the guidelines.',
    'tools: Read, Grep, tomAi_gitRead, mcp__tom-ai__tomAi_findFiles, Frobnicate',
    'model: sonnet',
    '---',
    '',
    'You are a careful reviewer. Report findings only.',
    '',
].join('\n'));
write('parent/workspace/.claude/agents/writer.md', [
    '---', 'name: writer', 'description: Writes the docs.', 'tools:', '  - Edit', '  - Write', '  - Bash', 'model: inherit', '---', 'You write docs.',
].join('\n'));
write('parent/workspace/.claude/agents/plain.md', 'A plain agent prompt without frontmatter.\n');
write('parent/workspace/.claude/agents/notes.txt', 'not an agent');
write('parent/.claude/agents/writer.md', '---\nname: writer\ndescription: The ancestor one, masked.\n---\nOld.\n');
write('parent/.claude/agents/fleet.md', '---\nname: fleet\ndescription: Fleet chores.\nmodel: claude-opus-5-5\n---\nYou handle the fleet.\n');

describe('agent definitions', () => {
    test('AD-1: discovery', () => {
        const defs = listAgentDefinitions(ws);
        assert.deepEqual(defs.map((d) => d.name), ['plain', 'reviewer', 'writer', 'fleet']);
        const reviewer = findAgentDefinition(ws, 'reviewer')!;
        assert.equal(reviewer.description, 'Reviews a diff against the guidelines.');
        assert.deepEqual(reviewer.tools, ['Read', 'Grep', 'tomAi_gitRead', 'mcp__tom-ai__tomAi_findFiles', 'Frobnicate']);
        assert.equal(reviewer.model, 'sonnet');
        assert.equal(reviewer.prompt, 'You are a careful reviewer. Report findings only.');
        assert.equal(reviewer.direct, true);
        const writer = findAgentDefinition(ws, 'writer')!;
        assert.equal(writer.description, 'Writes the docs.', 'the nearer one masks the ancestor\'s');
        assert.deepEqual(writer.tools, ['Edit', 'Write', 'Bash']);
        const plain = findAgentDefinition(ws, 'plain')!;
        assert.equal(plain.tools, undefined, 'no tools stated');
        assert.equal(plain.prompt, 'A plain agent prompt without frontmatter.');
        assert.equal(plain.description, 'A plain agent prompt without frontmatter.');
        assert.equal(findAgentDefinition(ws, 'fleet')!.direct, false);
        assert.equal(findAgentDefinition(ws, 'notes'), undefined);
    });

    test('AD-2: tool names for our own loop', () => {
        const { names, unknown } = toOurToolNames(findAgentDefinition(ws, 'reviewer')!.tools!);
        assert.deepEqual(names, ['tomAi_readFile', 'tomAi_findTextInFiles', 'tomAi_gitRead', 'tomAi_findFiles']);
        assert.deepEqual(unknown, ['Frobnicate']);
        assert.deepEqual(toOurToolNames(['Edit', 'Write', 'Bash', 'Glob', 'LS', 'MultiEdit', 'WebFetch', 'WebSearch', 'NotebookEdit']).names,
            ['tomAi_editFile', 'tomAi_createFile', 'tomAi_runCommand', 'tomAi_findFiles', 'tomAi_listDirectory', 'tomAi_multiEditFile',
                'tomAi_fetchWebpage', 'tomAi_webSearch', 'tomAi_notebookEdit']);
    });

    test('AD-3: the Agent SDK agents option', () => {
        const agents = toSdkAgents(listAgentDefinitions(ws));
        assert.deepEqual(Object.keys(agents), ['plain', 'reviewer', 'writer', 'fleet']);
        assert.deepEqual(agents.reviewer, {
            description: 'Reviews a diff against the guidelines.',
            prompt: 'You are a careful reviewer. Report findings only.',
            model: 'sonnet',
            tools: ['Read', 'Grep', 'mcp__tom-ai__tomAi_gitRead', 'mcp__tom-ai__tomAi_findFiles', 'Frobnicate'],
        });
        assert.equal('tools' in agents.plain, false, 'none stated: the SDK inherits');
        assert.equal(agents.writer.model, 'inherit');
    });

    test('AD-4: the configuration a sub-agent runs on', () => {
        const configs = [
            { id: 'opus-sdk', model: 'claude-opus-5-5', transport: 'agentSdk', isDefault: true },
            { id: 'sonnet-direct', model: 'claude-sonnet-5-5', transport: 'direct' },
            { id: 'sonnet-sdk', model: 'claude-sonnet-5-5', transport: 'agentSdk' },
            { id: 'local', model: 'qwen3', transport: 'localLlm' },
        ];
        const pick = (model: string | undefined, list = configs) => {
            const r = resolveSubagentConfiguration(list as never, model);
            return { id: (r.configuration as unknown as { id: string }).id, model: r.configuration.model, note: r.note };
        };
        assert.deepEqual(pick(undefined), { id: 'opus-sdk', model: 'claude-opus-5-5', note: undefined });
        assert.deepEqual(pick('inherit'), { id: 'opus-sdk', model: 'claude-opus-5-5', note: undefined });
        assert.equal(pick('sonnet').id, 'sonnet-sdk', 'the default\'s transport preferred');
        assert.equal(pick('claude-sonnet-5-5').id, 'sonnet-sdk');
        assert.equal(pick('qwen3').id, 'local');
        const unknownId = pick('claude-haiku-5-5');
        assert.deepEqual([unknownId.id, unknownId.model], ['opus-sdk', 'claude-haiku-5-5'], 'an id nobody has: the default with that model');
        const unknownAlias = pick('fable');
        assert.deepEqual([unknownAlias.id, unknownAlias.model], ['opus-sdk', 'claude-opus-5-5']);
        assert.match(unknownAlias.note ?? '', /fable/);
        const localDefault = [{ id: 'local', model: 'qwen3', transport: 'localLlm', isDefault: true }];
        const onLocal = pick('claude-haiku-5-5', localDefault);
        assert.deepEqual([onLocal.id, onLocal.model], ['local', 'qwen3'], 'a Local LLM default keeps its model');
        assert.match(onLocal.note ?? '', /claude-haiku-5-5/);
        assert.throws(() => resolveSubagentConfiguration([], undefined), /No Anthropic configuration/);
    });
});
