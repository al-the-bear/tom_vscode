/**
 * The TomSpecs / DocSpecs / CodeSpecs tools as a set (vsctsa22): how they are
 * found and what an unauthenticated caller can reach.
 *
 *   SS-1  every spec tool is registered, selectable and in one of the four spec picker categories
 *   SS-2  the read-only floor holds every reader and no writer; every writer needs approval
 *   SS-3  the writers are exactly the known set, so a new writer is a deliberate change here
 *   SS-4  the SOM tool descriptions teach: a real path, where to look first, the batch, the editor counterpart
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { ALL_SHARED_TOOLS, READ_ONLY_TOOLS } from '../tool-executors.js';
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';
import { CATEGORY_MAP } from '../../utils/toolCategories.js';

const SPEC = /^tomAi_(spec|docspecs)[A-Z]/;
const SOM = /^tomAi_spec(?!CodeSpecs)[A-Z]/;
const specTools = ALL_SHARED_TOOLS.filter((t) => SPEC.test(t.name));
const somTools = specTools.filter((t) => SOM.test(t.name));
const text = (t: { description: string; inputSchema: unknown }): string => `${t.description} ${JSON.stringify(t.inputSchema)}`;

const WRITERS = [
    'tomAi_docspecsReplaceSection',
    'tomAi_specAddNode',
    'tomAi_specApplyEdits',
    'tomAi_specAssignCommentIds',
    'tomAi_specClearSection',
    'tomAi_specCodeSpecsPlanTodos',
    'tomAi_specCodeSpecsSetVerdict',
    'tomAi_specCodeSpecsWriteExtracts',
    'tomAi_specConvert',
    'tomAi_specCreateDocument',
    'tomAi_specDecideMarks',
    'tomAi_specEditComment',
    'tomAi_specInsertComment',
    'tomAi_specInsertQuestion',
    'tomAi_specMoveListItem',
    'tomAi_specRemoveAllAnnotations',
    'tomAi_specRemoveListItem',
    'tomAi_specResolveAnnotation',
    'tomAi_specSetAnswer',
    'tomAi_specSetCodeSpec',
    'tomAi_specSetContent',
    'tomAi_specSetFormField',
    'tomAi_specSetHeadline',
    'tomAi_specSetItemSectionId',
    'tomAi_specWriteAnswers',
];

/** The TomSpecs editor's tool each extension tool corresponds to (tom_specs_model/doc/llm_and_d4rt_tools.md §8). */
const COUNTERPARTS: Array<[string, string[]]> = [
    ['tomAi_specOutline', ['doc_outline']],
    ['tomAi_specGetSection', ['doc_get_content', 'doc_get_form_field', 'doc_section_meta']],
    ['tomAi_specReflect', ['doc_reflect']],
    ['tomAi_specSearch', ['doc_search']],
    ['tomAi_specSearchIterate', ['doc_search_iterate']],
    ['tomAi_specSetContent', ['doc_set_content']],
    ['tomAi_specSetFormField', ['doc_set_form_field']],
    ['tomAi_specAddNode', ['doc_add_node', 'doc_add_list_item']],
    ['tomAi_specRemoveListItem', ['doc_remove_list_item']],
];

describe('the spec tools as a set', () => {
    test('SS-1: registered, selectable, grouped in the pickers', () => {
        assert.equal(specTools.length, 49);
        const categories = ['TomSpecs', 'TomSpecs (edit)', 'DocSpecs', 'CodeSpecs'];
        for (const t of specTools) {
            assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes(t.name), `${t.name} is not selectable`);
            const home = categories.filter((c) => CATEGORY_MAP[c]?.includes(t.name));
            assert.equal(home.length, 1, `${t.name} must sit in exactly one spec category, is in ${JSON.stringify(home)}`);
        }
        const listed = categories.flatMap((c) => CATEGORY_MAP[c]);
        assert.deepEqual(listed.filter((n) => !SPEC.test(n)), [], 'the spec categories hold spec tools only');
    });

    test('SS-2: the read-only floor holds every reader and no writer', () => {
        const floor = new Set(READ_ONLY_TOOLS.map((t) => t.name));
        for (const t of specTools) {
            if (t.readOnly) {
                assert.ok(floor.has(t.name), `${t.name} is read-only but not on the floor`);
                assert.notEqual(t.requiresApproval, true, `${t.name} reads only and should not ask for approval`);
            } else {
                assert.ok(!floor.has(t.name), `${t.name} writes and must not be on the floor`);
                assert.equal(t.requiresApproval, true, `${t.name} writes without approval`);
            }
        }
    });

    test('SS-3: the writers are exactly the known set', () => {
        assert.deepEqual(specTools.filter((t) => !t.readOnly).map((t) => t.name).sort(), WRITERS);
    });

    test('SS-4: the SOM descriptions teach', () => {
        for (const t of somTools) {
            const all = text(t);
            if (/"(path|parentPath|itemPath|edits)"/.test(JSON.stringify(t.inputSchema))) {
                assert.match(all, /SBP\/introductionAndScope\/requirements\/functionalRequirements\/FRE-REQU-LST-1/, `${t.name}: no real path example`);
            }
            if (t.name !== 'tomAi_specOutline' && t.name !== 'tomAi_specReflect') {
                assert.match(t.description, /tomAi_specOutline|tomAi_specReflect/, `${t.name}: does not say where to look first`);
            }
        }
        const singleEdits = somTools.filter((t) => !t.readOnly && !['tomAi_specApplyEdits', 'tomAi_specCreateDocument', 'tomAi_specConvert', 'tomAi_specWriteAnswers'].includes(t.name));
        assert.equal(singleEdits.length, 17);
        for (const t of singleEdits) {
            assert.match(t.description, /tomAi_specApplyEdits/, `${t.name}: does not point to the batch for more than one change`);
        }
        for (const [name, counterparts] of COUNTERPARTS) {
            const t = somTools.find((x) => x.name === name)!;
            for (const c of counterparts) { assert.ok(text(t).includes(c), `${name}: counterpart ${c} not named`); }
        }
    });
});
