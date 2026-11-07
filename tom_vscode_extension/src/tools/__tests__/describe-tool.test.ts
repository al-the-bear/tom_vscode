/**
 * tomAi_describeTool and the short tool descriptions (dapieff6, DA-5 (a), DA-17 (a)).
 *
 *   TD-1 the tool: an unknown name is refused with similar names; a known one answers its description, every
 *        argument (type, required, description, enum, nested properties) and its doc/llm_tools.md section
 *   TD-2 the doc reading: a tool's own section ends at the next heading of its level; fenced headings do not
 *        count; other lines naming it are `mentions`
 *   TD-3 every tool description is at most 1,250 characters (the longest after the pass); the descriptions the
 *        pass shortened keep their long form in §10 of doc/llm_tools.md, every §10 section names a registered tool
 *   TD-4 registered read-only, selectable, in the Tool Help category; doc/llm_tools.md is packaged
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { withTiming } from './_timing.js';
import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { ALL_SHARED_TOOLS, READ_ONLY_TOOLS } from '../tool-executors.js';
import { DESCRIBE_TOOL_TOOL, TOOL_DOC_PATH, describeToolImpl } from '../describe-tool.js';
import { toolArguments, toolDocumentation } from '../../utils/toolDocs.js';
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';
import { CATEGORY_MAP } from '../../utils/toolCategories.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DOC = fs.readFileSync(path.join(ROOT, 'doc', 'llm_tools.md'), 'utf8');
const deps = { tools: () => ALL_SHARED_TOOLS, readDoc: () => DOC };
/** The cap: the longest description after the pass (tomAi_specInsertQuestion, 1,221), rounded up. */
const MAX_DESCRIPTION_CHARS = 1250;

describe('tomAi_describeTool', () => {
    test('TD-1: the tool', async () => {
        const missing = JSON.parse(describeToolImpl(deps, { name: 'tomAi_createQuest' }));
        assert.equal(missing.ok, false);
        assert.ok(missing.similar.includes('tomAi_createQuestTodo'));
        assert.equal(JSON.parse(describeToolImpl(deps, { name: '' })).ok, false);

        const r = JSON.parse(await withTiming('tomAi_describeTool:typical', async () => describeToolImpl(deps, { name: 'tomAi_createQuestTodo' })));
        assert.equal(r.ok, true);
        assert.equal(r.readOnly, false);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const byName: Record<string, any> = Object.fromEntries((r.arguments as Array<{ name: string }>).map((a) => [a.name, a]));
        assert.deepEqual([byName.questId.required, byName.file.required, byName.todo.type], [true, false, 'object']);
        const status = byName.todo.properties.find((a: { name: string }) => a.name === 'status');
        assert.ok(status.enum.includes('decision-needed'));
        assert.match(r.documentation, /^### `tomAi_createQuestTodo`/);
        assert.match(r.documentation, /auto-id rules/, 'the long form');
        assert.ok(r.mentions.length > 0, 'the family table names it');
        // Case-insensitive, and a tool without a §10 section still answers its mentions.
        const plain = JSON.parse(describeToolImpl(deps, { name: 'tomai_generateidprefix' }));
        assert.equal(plain.name, 'tomAi_generateIdPrefix');
        assert.equal(plain.documentation, null);
        assert.ok(plain.mentions.length > 0);
        // The live dependency reads the bundled document.
        assert.equal(TOOL_DOC_PATH, path.join(ROOT, 'doc', 'llm_tools.md'));
    });

    test('TD-2: the doc reading', () => {
        const md = ['# Doc', '| `a_x` | row |', '### `a_x`', 'body', '```', '### `a_y` in a fence', '```', 'more', '#### sub', 'deeper', '### `a_y`', 'other', '## next'].join('\n');
        const x = toolDocumentation(md, 'a_x');
        assert.equal(x.section, ['### `a_x`', 'body', '```', '### `a_y` in a fence', '```', 'more', '#### sub', 'deeper'].join('\n'));
        assert.deepEqual(x.mentions, ['| `a_x` | row |']);
        assert.equal(toolDocumentation(md, 'a_y').section, '### `a_y`\nother');
        assert.deepEqual(toolDocumentation(md, 'a_z'), { section: '', mentions: [] });
        assert.deepEqual(toolArguments({ type: 'object', required: ['k'], properties: {
            k: { type: 'string', description: 'K.' }, n: { type: ['string', 'number'] }, l: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
        } }), [
            { name: 'k', type: 'string', required: true, description: 'K.' },
            { name: 'n', type: 'string | number', required: false },
            { name: 'l', type: 'array of string', required: false, enum: ['a', 'b'] },
        ]);
    });

    test('TD-3: short descriptions, long forms in §10', () => {
        const long = ALL_SHARED_TOOLS.filter((t) => t.description.length > MAX_DESCRIPTION_CHARS).map((t) => `${t.name} (${t.description.length})`);
        assert.deepEqual(long, [], `descriptions over ${MAX_DESCRIPTION_CHARS} characters: move the rest to doc/llm_tools.md §10`);
        const details = DOC.slice(DOC.indexOf('## 10. Tool details'));
        const sections = [...details.matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]);
        const names = new Set(ALL_SHARED_TOOLS.map((t) => t.name));
        assert.deepEqual(sections.filter((n) => !names.has(n)), [], 'every §10 section names a registered tool');
        for (const n of ['tomAi_createQuestTodo', 'tomAi_updateQuestTodo', 'tomAi_addQueueItem', 'tomAi_specInsertQuestion', 'tomAi_specApplyEdits', 'tomAi_askUserPicker']) {
            assert.ok(sections.includes(n), `${n}: no long form in §10`);
        }
        assert.ok(sections.length >= 20, 'the pass covered at least the 20 longest');
    });

    test('TD-4: registered and packaged', () => {
        assert.equal(DESCRIBE_TOOL_TOOL.readOnly, true);
        assert.ok(ALL_SHARED_TOOLS.includes(DESCRIBE_TOOL_TOOL));
        assert.ok(READ_ONLY_TOOLS.some((t) => t.name === 'tomAi_describeTool'), 'on the read-only floor');
        assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes('tomAi_describeTool'));
        assert.deepEqual(CATEGORY_MAP['Tool Help'], ['tomAi_describeTool']);
        assert.match(fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8'), /^!doc\/llm_tools\.md$/m);
        assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'check-vsix-contents.cjs'), 'utf8'), /'extension\/doc\/llm_tools\.md'/);
    });
});
