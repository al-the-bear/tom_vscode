/**
 * Which tools a request carries (dapieff7: DA-4 (b), DA-16 (a), CC-127 (a)) —
 * src/utils/toolSelection.ts, the cache breakpoint, the payload dump and the
 * handler's wiring.
 *
 *   TS-1 the directive: `<!-- tools: … -->` lines (several, multi-line) give their entries in order without
 *        repeats, and are removed from the text sent
 *   TS-2 entries: a tool name, a family (any case), a `prefix*`; only tools of the profile; the rest `unknown`
 *   TS-3 per transport: direct defers everything outside the core set, the profile's additions and the prompt's
 *        tools; `toolSearch: false` and an all-core profile defer nothing; Local LLM and VS Code LM: the whole
 *        list without a directive, the core set plus the prompt's tools with one; the Agent SDK unchanged
 *   TS-4 the request's tools: in full first, then the BM25 search tool, then the deferred ones with
 *        `defer_loading`; the cache breakpoint on the last tool the model reads, not on a deferred one
 *   TS-5 the core set names registered tools; with every tool, the model reads under 15 % of the schemas
 *   TS-6 the payload dump marks deferred and prompt-named tools and an unknown entry; the handler plans the
 *        tools at the top of sendMessage and the direct leaf sends them with tool search; the profile keys are
 *        in the schema, the config type and the profile editor
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    DEFAULT_CORE_TOOLS, TOOL_SEARCH_TOOL, planRequestTools, resolveToolEntries, stripToolsDirectives,
    toolsDirectiveEntries, withToolSearch,
} from '../toolSelection.js';
import { withToolsCacheBreakpoint } from '../anthropicPromptCache.js';
import { ALL_SHARED_TOOLS } from '../../tools/tool-executors.js';
import { toAnthropicTools } from '../../tools/shared-tool-registry.js';
import { CATEGORY_MAP } from '../toolCategories.js';
import { buildPayloadDump } from '../../services/anthropicPayload.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const src = (...p: string[]): string => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CATS = { 'TomSpecs (edit)': ['tomAi_specSetContent', 'tomAi_specApplyEdits'], Web: ['tomAi_webSearch'] };
const PROFILE = ['tomAi_readFile', 'tomAi_editFile', 'tomAi_specSetContent', 'tomAi_specApplyEdits', 'tomAi_specOutline', 'tomAi_webSearch', 'tomAi_listQueue'];

describe('tool selection', () => {
    test('TS-1: the directive', () => {
        const text = 'Do it.\n<!-- tools: tomAi_specOutline, TomSpecs (edit) -->\nmore\n<!--tools:\n  tomAi_spec*,\n  tomAi_specOutline\n-->';
        assert.deepEqual(toolsDirectiveEntries(text, undefined, '<!-- TOOLS: tomAi_listQueue -->'),
            ['tomAi_specOutline', 'TomSpecs (edit)', 'tomAi_spec*', 'tomAi_listQueue']);
        assert.equal(stripToolsDirectives(text), 'Do it.\nmore\n');
        assert.equal(stripToolsDirectives('no directive <!-- a comment -->'), 'no directive <!-- a comment -->');
        assert.deepEqual(toolsDirectiveEntries('<!-- other -->'), []);
    });

    test('TS-2: entries', () => {
        assert.deepEqual(resolveToolEntries(['tomAi_specOutline', 'tomas (edit)', 'tomspecs (EDIT)', 'tomAi_list*', 'tomAi_nope', 'web', 'tomAi_zzz*'], PROFILE, CATS), {
            names: ['tomAi_specOutline', 'tomAi_specSetContent', 'tomAi_specApplyEdits', 'tomAi_listQueue', 'tomAi_webSearch'],
            unknown: ['tomas (edit)', 'tomAi_nope', 'tomAi_zzz*'],
        });
        assert.deepEqual(resolveToolEntries(['tomAi_webSearch'], ['tomAi_readFile'], CATS).names, [], 'never a tool outside the profile');
    });

    test('TS-3: per transport', () => {
        const base = { profileTools: PROFILE, categories: CATS };
        const direct = planRequestTools({ ...base, transport: 'direct', directive: [] });
        assert.deepEqual(direct.tools, PROFILE, 'every tool stays callable');
        assert.deepEqual(direct.deferred, ['tomAi_specSetContent', 'tomAi_specApplyEdits', 'tomAi_specOutline', 'tomAi_webSearch', 'tomAi_listQueue']);
        const named = planRequestTools({ ...base, transport: 'direct', directive: ['TomSpecs (edit)'], profileCore: ['tomAi_listQueue'] });
        assert.deepEqual(named.deferred, ['tomAi_specOutline', 'tomAi_webSearch']);
        assert.deepEqual(named.fromPrompt, ['tomAi_specSetContent', 'tomAi_specApplyEdits']);
        assert.deepEqual(planRequestTools({ ...base, transport: 'direct', directive: [], toolSearch: false }).deferred, []);
        assert.deepEqual(planRequestTools({ ...base, profileTools: ['tomAi_webSearch'], transport: 'direct', directive: [] }).deferred, [], 'no tool in full: nothing deferred');
        for (const transport of ['localLlm', 'vscodeLm'] as const) {
            assert.deepEqual(planRequestTools({ ...base, transport, directive: [] }).tools, PROFILE, `${transport}: no directive, the whole list`);
            assert.deepEqual(planRequestTools({ ...base, transport, directive: ['tomAi_webSearch'] }).tools, ['tomAi_readFile', 'tomAi_editFile', 'tomAi_webSearch'], `${transport}: core + the prompt's`);
        }
        assert.deepEqual(planRequestTools({ ...base, transport: 'agentSdk', directive: ['tomAi_webSearch'] }), { tools: PROFILE, deferred: [], fromPrompt: ['tomAi_webSearch'], unknown: [] });
    });

    test('TS-4: the request\'s tools and the cache breakpoint', () => {
        const tools = PROFILE.map((name) => ({ name, input_schema: {} }));
        const sent = withToolSearch(tools, ['tomAi_specOutline', 'tomAi_webSearch']);
        assert.deepEqual(sent.map((t) => t.name), ['tomAi_readFile', 'tomAi_editFile', 'tomAi_specSetContent', 'tomAi_specApplyEdits', 'tomAi_listQueue', 'tool_search_tool_bm25', 'tomAi_specOutline', 'tomAi_webSearch']);
        assert.deepEqual(sent[5], TOOL_SEARCH_TOOL);
        assert.equal(TOOL_SEARCH_TOOL.type, 'tool_search_tool_bm25_20251119');
        assert.deepEqual(sent.slice(6).map((t) => (t as { defer_loading?: boolean }).defer_loading), [true, true]);
        assert.equal((tools[2] as { defer_loading?: boolean }).defer_loading, undefined, 'the input is not changed');
        const marked = withToolsCacheBreakpoint(sent);
        assert.deepEqual(marked.map((t) => 'cache_control' in t), [false, false, false, false, false, true, false, false], 'the breakpoint on the search tool');
        assert.deepEqual(withToolSearch(tools, []).map((t) => t.name), PROFILE, 'nothing deferred: no search tool');
    });

    test('TS-5: the core set, and what the model reads', () => {
        const names = new Set(ALL_SHARED_TOOLS.map((t) => t.name));
        assert.equal(DEFAULT_CORE_TOOLS.length, 20);
        assert.deepEqual(DEFAULT_CORE_TOOLS.filter((n) => !names.has(n)), [], 'every core tool is registered');
        const all = toAnthropicTools(ALL_SHARED_TOOLS);
        const plan = planRequestTools({ transport: 'direct', profileTools: ALL_SHARED_TOOLS.map((t) => t.name), directive: [], categories: CATEGORY_MAP });
        const read = withToolSearch(all, plan.deferred).filter((t) => !(t as { defer_loading?: boolean }).defer_loading);
        const share = JSON.stringify(read).length / JSON.stringify(all).length;
        assert.ok(share < 0.15, `the model reads ${(share * 100).toFixed(1)} % of the tool schemas`);
    });

    test('TS-6: the dump, the handler, the settings', () => {
        const dump = buildPayloadDump({
            requestId: 'r', transport: 'direct', configuration: { id: 'c', name: 'c', model: 'm', maxTokens: 1, maxRounds: 1 } as never,
            profile: { id: 'p', name: 'p', description: '', systemPrompt: '' }, systemPrompt: '', history: [], userContent: 'u', effectiveCaching: false,
            tools: ALL_SHARED_TOOLS.filter((t) => ['tomAi_readFile', 'tomAi_specOutline', 'tomAi_listQueue'].includes(t.name)),
            toolPlan: { deferred: ['tomAi_specOutline', 'tomAi_listQueue'], fromPrompt: ['tomAi_listQueue'], unknown: ['tomAi_nope'] },
        });
        assert.match(dump, /## Tools \(3; 1 in full, 2 deferred — found by tool search\)/);
        assert.match(dump, /- `tomAi_specOutline` \(deferred\)/);
        assert.match(dump, /- `tomAi_listQueue` \(deferred, named by the prompt\)/);
        assert.match(dump, /directive named no tool of the profile for: `tomAi_nope`/);

        const handler = src('src', 'handlers', 'anthropic-handler.ts');
        assert.match(handler, /async sendMessage\(options: AnthropicSendOptions\): Promise<AnthropicSendResult> \{\n\s+options = withToolPlan\(options\);/);
        assert.match(handler, /const anthropicTools = withToolSearch\(toAnthropicTools\(tools\), options\.toolPlan\?\.deferred \?\? \[\]\)/);
        assert.match(handler, /userText: stripToolsDirectives\(options\.userText\)/);
        assert.match(handler, /toolPlan: options\.toolPlan/, 'the payload dump gets the plan');
        const schema = JSON.parse(src('src', 'config', 'tom_vscode_extension.schema.json'));
        const profile = schema.definitions.anthropicProfile.properties;
        assert.deepEqual([profile.coreTools.type, profile.toolSearch.type], ['array', 'boolean']);
        assert.match(src('src', 'utils', 'sendToChatConfig.ts'), /coreTools\?: string\[\];[\s\S]*toolSearch\?: boolean;/);
        const editor = src('src', 'handlers', 'globalTemplateEditor-handler.ts');
        assert.match(editor, /name: 'coreTools', label: 'Core Tools \(added\)'/);
        assert.match(editor, /name: 'toolSearch', label: 'Tool Search \(direct\)'/);
    });
});
