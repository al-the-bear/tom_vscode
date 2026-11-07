/**
 * The todo's record in every prompt of a todo iteration (dapieff8: DA-10, DA-22)
 * — src/utils/todoIterationRecord.ts and the queue's expansion.
 *
 *   TI-1 the record: every stored field — decisions with their answers, notes, references, scope, blocked_by,
 *        unknown fields kept aside by the reader — without the derived `blocking` and the reader's `_sourceFile`
 *   TI-2 the block: "Here is the complete YAML of the todo:", a yaml fence headed by the file; a `${…}` in the
 *        todo survives the queue's placeholder passes and arrives as written
 *   TI-3 which todo: the main prompt its claimed todo, a pre-prompt the next one, a follow-up the last one;
 *        nothing outside a todo iteration
 *   TI-4 all three stages through the expansion, with a custom template and without: every prompt ends with the
 *        whole record, so a stage in a fresh session (per-iteration, per-prompt) has the todo and its decisions
 *   TI-5 the queue manager passes the block for every stage and appends it before its template passes
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { TODO_YAML_INTRO, todoForStage, todoRecordForPrompt, todoYamlBlock, withTodoYaml } from '../todoIterationRecord.js';
import { resolveVariables, unescapePlaceholders } from '../variableResolver.js';
import { resolveTemplate } from '../../handlers/promptTemplate.js';
import { escapePlaceholders } from '../placeholderEscape.js';
import { fillTemplate } from '../copilotTemplates.js';

const TODO: Record<string, unknown> = {
    id: 'dsa7_akeq-fix-it',
    title: 'Fix it',
    description: 'Make `${repeatTodoId}` print right; see `$${literal}`.',
    status: 'in-progress',
    priority: 'high',
    tags: ['queue'],
    notes: 'Tried once.',
    blocked_by: ['dsa6_akeq-prep'],
    blocking: ['dsa8_akeq-after'],
    references: [{ path: 'src/a.ts', lines: '10-20' }],
    scope: { files: ['src/a.ts'] },
    decisions: [{ summary: 'Which way?', decision_needed: '(a) or (b)', decision: '(b)' }],
    user_action: false,
    dependencies: [],
    completed_by: '',
    _sourceFile: 'todos.q.todo.yaml',
    _extra: { execution_role: 'dev' },
};

const resolve = (text: string, values: Record<string, string>): string =>
    resolveVariables(text, { values, includeEditor: false, unresolvedBehavior: 'empty' });

/** The queue's passes for one stage: repeat placeholders, the record appended, the template, the send. */
function expandStage(text: string, block: string | undefined, template?: string): string {
    const repeatPass = resolve(text, { repeatTodoId: 'dsa7_akeq-fix-it', repeatTodoTitle: 'Fix it', repeatNumber: '7' });
    const withRecord = withTodoYaml(repeatPass, block);
    const templated = template ? resolveTemplate(fillTemplate(template, withRecord), {}) : resolveTemplate(withRecord, {});
    return unescapePlaceholders(templated);
}

function recordIn(prompt: string): Record<string, unknown> {
    const at = prompt.indexOf(TODO_YAML_INTRO);
    assert.ok(at >= 0, 'the intro line');
    const fence = prompt.slice(at).match(/```yaml\n([\s\S]*?)\n```/);
    assert.ok(fence, 'a yaml fence');
    return yaml.parse(fence![1]);
}

describe('the todo record in iteration prompts', () => {
    test('TI-1: the record', () => {
        const r = todoRecordForPrompt(TODO);
        assert.equal('blocking' in r, false, 'blocking is derived');
        assert.equal('_sourceFile' in r, false);
        assert.equal('_extra' in r, false);
        assert.equal(r.execution_role, 'dev', 'fields the reader kept aside are back');
        assert.deepEqual(r.decisions, [{ summary: 'Which way?', decision_needed: '(a) or (b)', decision: '(b)' }]);
        assert.deepEqual([r.notes, r.blocked_by, r.scope, r.references], ['Tried once.', ['dsa6_akeq-prep'], { files: ['src/a.ts'] }, [{ path: 'src/a.ts', lines: '10-20' }]]);
        assert.equal(r.user_action, false, 'false is a value');
        assert.equal('dependencies' in r || 'completed_by' in r, false, 'empty values are left out');
    });

    test('TI-2: the block', () => {
        const block = todoYamlBlock(TODO, '_ai/quests/q/todos.q.todo.yaml');
        assert.ok(block.startsWith(`${TODO_YAML_INTRO}\n\n\`\`\`yaml\n# _ai/quests/q/todos.q.todo.yaml\n`));
        assert.ok(!/(^|[^$])\$\{/.test(block), 'every placeholder in it is escaped');
        assert.equal(unescapePlaceholders(escapePlaceholders('x ${a} $${b} ${{c}}')), 'x ${a} $${b} ${{c}}', 'the round trip is exact');
        const sent = unescapePlaceholders(resolveTemplate(resolve(block, { repeatTodoId: 'X' }), {}));
        assert.equal(recordIn(sent).description, TODO.description, 'arrives as stored');
        assert.equal(escapePlaceholders('a ${b} $${c} ${{d}}'), 'a $${b} $$${c} $${{d}}');
    });

    test('TI-3: which todo', () => {
        const ctx = { isTodoIteration: true, claimedId: 'dsa7', nextId: 'dsa8', lastId: 'dsa6' };
        assert.deepEqual(['prePrompt', 'main', 'followUp'].map((s) => todoForStage(s as 'main', ctx)), ['dsa8', 'dsa7', 'dsa6']);
        assert.equal(todoForStage('main', { ...ctx, isTodoIteration: false }), undefined);
        assert.equal(todoForStage('prePrompt', { isTodoIteration: true }), undefined, 'no todo to pick yet');
    });

    test('TI-4: all three stages, with and without a template', () => {
        const block = todoYamlBlock(TODO, '_ai/quests/q/todos.q.todo.yaml');
        const template = 'Context first.\n\n${userMessage}\n\nAnswer briefly.';
        const stages = {
            prePrompt: expandStage('Prepare the walk.', block),
            main: expandStage('Do my own thing with ${repeatTodoId}.', block, template),
            followUp: expandStage('Summarise todo ${repeatNumber}.', block),
        };
        for (const [stage, prompt] of Object.entries(stages)) {
            const r = recordIn(prompt);
            assert.equal(r.id, 'dsa7_akeq-fix-it', stage);
            assert.equal((r.decisions as Array<{ decision: string }>)[0].decision, '(b)', `${stage}: the decision's answer — enough for a fresh session`);
            assert.equal(r.description, TODO.description, `${stage}: as stored`);
        }
        assert.match(stages.main, /^Context first\.\n\nDo my own thing with dsa7_akeq-fix-it\.\n\nHere is the complete YAML of the todo:/, 'inside the template, after the text');
        assert.match(stages.main, /```\n\nAnswer briefly\.$/);
        assert.equal(expandStage('Plain item.', undefined), 'Plain item.', 'no iteration: nothing appended');
    });

    test('TI-5: the queue manager', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'src', 'managers', 'promptQueueManager.ts'), 'utf8');
        assert.match(src, /this\.iterationTodoBlock\(item, 'prePrompt'\),\n\s+\);/);
        assert.match(src, /this\.iterationTodoBlock\(item, 'main', iterationTodo\?\.id\),\n\s+\);/);
        assert.match(src, /this\.iterationTodoBlock\(item, 'followUp'\),\n\s+\);/);
        assert.match(src, /expandTemplate\(withTodoYaml\(withResolvedAffixes, todoBlock\)/, 'appended before the template passes');
        assert.match(src, /nextId: stage === 'prePrompt' \? pickNextTodoForIteration\(item\.repeatCount, readQuestTodoEntries\(questId\)\)\?\.id/);
        assert.match(src, /lastId: item\.repeatTodoId/);
    });
});
