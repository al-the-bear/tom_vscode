/**
 * The Quest TODO "Send to Chat" button follows the prompt queue's selected
 * transport (Copilot vs Anthropic); both offer the one template store.
 * `buildTodoSendTemplateChoices` is the pure decision: which templates to offer,
 * and which is pre-selected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

installVscodeStub({ workspaceFolders: [process.cwd()] });

describe('buildTodoSendTemplateChoices', () => {
    it('copilot: offers the one template store, the user-message templates, and no wrapper option', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        const choices = buildTodoSendTemplateChoices('copilot', {
            anthropic: { userMessageTemplates: [{ id: 'execute-todo', name: 'Execute TODO' }, { id: 'explain-todo', name: 'Explain TODO' }] },
        });
        assert.equal(choices.transport, 'copilot');
        assert.deepEqual(choices.templates.map((t) => t.id), ['__none__', 'execute-todo', 'explain-todo']);
        assert.ok(!choices.templates.some((t) => t.id === '__answer_file__'), 'the wrapper is not a template choice');
        assert.equal(choices.selected, 'execute-todo');
    });

    it('anthropic: offers the user-message templates, no copilot-only options', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        const choices = buildTodoSendTemplateChoices('anthropic', {
            anthropic: { userMessageTemplates: [{ id: 'execute-todo', name: 'Execute TODO' }, { id: 'fast', name: 'Fast' }] },
        });
        assert.equal(choices.transport, 'anthropic');
        const ids = choices.templates.map((t) => t.id);
        assert.deepEqual(ids, ['__none__', 'execute-todo', 'fast']);
        assert.ok(!ids.includes('__answer_file__'), 'no copilot answer wrapper for anthropic');
        assert.ok(!ids.includes('TODO Execution'), 'no copilot built-ins for anthropic');
        // labels come from the template name
        assert.equal(choices.templates.find((t) => t.id === 'fast')?.label, 'Fast');
    });

    it('anthropic: defaults to the Execute TODO template when no isDefault flag', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        const choices = buildTodoSendTemplateChoices('anthropic', {
            anthropic: { userMessageTemplates: [{ id: 'fast', name: 'Fast' }, { id: 'execute-todo', name: 'Execute TODO' }] },
        });
        assert.equal(choices.selected, 'execute-todo');
    });

    it('anthropic: the isDefault flag wins over the Execute TODO fallback', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        const choices = buildTodoSendTemplateChoices('anthropic', {
            anthropic: { userMessageTemplates: [{ id: 'fast', name: 'Fast', isDefault: true }, { id: 'execute-todo', name: 'Execute TODO' }] },
        });
        assert.equal(choices.selected, 'fast');
    });

    it('the queue default template id wins when it names an offered option', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        const anth = buildTodoSendTemplateChoices(
            'anthropic',
            { anthropic: { userMessageTemplates: [{ id: 'fast', name: 'Fast', isDefault: true }, { id: 'execute-todo', name: 'Execute TODO' }] } },
            'execute-todo',
        );
        assert.equal(anth.selected, 'execute-todo', 'queue pick overrides isDefault');

        const cop = buildTodoSendTemplateChoices('copilot', { anthropic: { userMessageTemplates: [{ id: 'fast', name: 'Fast', isDefault: true }, { id: 'execute-todo', name: 'Execute TODO' }] } }, 'execute-todo');
        assert.equal(cop.selected, 'execute-todo', 'queue pick overrides isDefault on copilot too');
    });

    it('an unmatched queue default template id is ignored', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        const choices = buildTodoSendTemplateChoices('anthropic', {
            anthropic: { userMessageTemplates: [{ id: 'fast', name: 'Fast', isDefault: true }] },
        }, 'no-such-id');
        assert.equal(choices.selected, 'fast');
    });

    it('anthropic: Explain TODO is offered beside Execute TODO, which stays the fallback', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        const choices = buildTodoSendTemplateChoices('anthropic', {
            anthropic: { userMessageTemplates: [{ id: 'explain-todo', name: 'Explain TODO' }, { id: 'execute-todo', name: 'Execute TODO' }] },
        });
        assert.deepEqual(choices.templates.map((t) => t.label), ['(None)', 'Explain TODO', 'Execute TODO']);
        assert.equal(choices.selected, 'execute-todo');
        const picked = buildTodoSendTemplateChoices('anthropic', {
            anthropic: { userMessageTemplates: [{ id: 'explain-todo', name: 'Explain TODO' }, { id: 'execute-todo', name: 'Execute TODO' }] },
        }, 'explain-todo');
        assert.equal(picked.selected, 'explain-todo');
    });

    it('anthropic with no templates falls back to __none__', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        const choices = buildTodoSendTemplateChoices('anthropic', {});
        assert.deepEqual(choices.templates.map((t) => t.id), ['__none__']);
        assert.equal(choices.selected, '__none__');
    });
});

describe('buildStackedTodoPrompt', () => {
    it('single todo keeps the classic #TODO= responseValue key', async () => {
        const { buildStackedTodoPrompt } = await import('../todoSendTargets.js');
        const prompt = buildStackedTodoPrompt([
            { yaml: '- id: _ai/quests/q/todos.q.todo.yaml/T1\n  title: One', ref: '_ai/quests/q/todos.q.todo.yaml/T1' },
        ]);
        assert.ok(prompt.startsWith('- id: _ai/quests/q/todos.q.todo.yaml/T1'));
        assert.ok(prompt.includes('REQUIRED: Add responseValue #TODO=_ai/quests/q/todos.q.todo.yaml/T1'));
        assert.ok(!prompt.includes('#TODO_1='), 'no numbered key for a single todo');
        assert.ok(prompt.endsWith('\n\n'), 'trailing separator preserved');
    });

    it('multiple todos: one block per todo, in stack order, separated by a blank line', async () => {
        const { buildStackedTodoPrompt } = await import('../todoSendTargets.js');
        const prompt = buildStackedTodoPrompt([
            { yaml: 'Todo `f/a.todo.yaml/A`.\n\nrecord A', ref: 'f/a.todo.yaml/A' },
            { yaml: 'Todo `f/a.todo.yaml/B`.\n\nrecord B', ref: 'f/a.todo.yaml/B' },
            { yaml: 'Todo `f/b.todo.yaml/C`.\n\nrecord C', ref: 'f/b.todo.yaml/C' },
        ]);
        const blocks = prompt.split('\n\nREQUIRED')[0];
        assert.equal(blocks, 'Todo `f/a.todo.yaml/A`.\n\nrecord A\n\nTodo `f/a.todo.yaml/B`.\n\nrecord B\n\nTodo `f/b.todo.yaml/C`.\n\nrecord C');
        assert.ok(prompt.indexOf('/A') < prompt.indexOf('/B'), 'stack order preserved');
    });

    it('multiple todos get DISTINCT numbered #TODO_<n>= responseValue keys', async () => {
        const { buildStackedTodoPrompt } = await import('../todoSendTargets.js');
        const prompt = buildStackedTodoPrompt([
            { yaml: '- id: A', ref: 'f/x.todo.yaml/A' },
            { yaml: '- id: B', ref: 'f/x.todo.yaml/B' },
        ]);
        assert.ok(prompt.includes('REQUIRED: Add responseValue #TODO_1=f/x.todo.yaml/A'));
        assert.ok(prompt.includes('REQUIRED: Add responseValue #TODO_2=f/x.todo.yaml/B'));
        assert.ok(!/#TODO=/.test(prompt), 'no ambiguous unnumbered key when stacked');
    });
});

/**
 * dapieff9: a todo sent from the todo panel carries its whole record, the
 * block a todo iteration appends — through Execute TODO, Guide me and
 * Explain TODO alike.
 *
 *   SN-1 the panel's block: the reference, "Here is the complete YAML of the todo:", the record headed by its file,
 *        decisions with their answers, no `blocking`
 *   SN-2 through each template (filled and resolved as the queue and the send do, then unescaped): the whole
 *        record arrives, a `${…}` in it as written; the panel builds every send from this block, and the direct
 *        Copilot send unescapes
 */
describe('todo panel sends carry the todo record', () => {
    const TODO = {
        id: 'abc3_akfq-thing',
        title: 'A thing',
        description: 'Uses `${repeatTodoId}` literally.',
        status: 'not-started',
        decisions: [{ summary: 'Pick one', decision_needed: '(a) or (b)', decision: '(a)' }],
        blocking: ['abc4_akfq-next'],
        notes: 'n',
        _sourceFile: 'todos.q.todo.yaml',
    };
    const REF = '_ai/quests/q/todos.q.todo.yaml/abc3_akfq-thing';

    it('SN-1: the block', async () => {
        const { todoSendBlock } = await import('../todoSendTargets.js');
        const { todoYamlBlock, TODO_YAML_INTRO } = await import('../todoIterationRecord.js');
        const block = todoSendBlock(REF, todoYamlBlock(TODO, '_ai/quests/q/todos.q.todo.yaml'));
        assert.ok(block.startsWith(`Todo \`${REF}\`.\n\n${TODO_YAML_INTRO}\n\n\`\`\`yaml\n# _ai/quests/q/todos.q.todo.yaml\n`));
        assert.ok(block.includes('decision: (a)'));
        assert.ok(!block.includes('blocking'), 'blocking is derived');
    });

    it('SN-2: through Execute TODO, Guide me and Explain TODO', async () => {
        const { installVscodeStub } = await import('../../tools/__tests__/_vscode-stub.js');
        installVscodeStub({});
        const { buildStackedTodoPrompt, todoSendBlock } = await import('../todoSendTargets.js');
        const { todoYamlBlock } = await import('../todoIterationRecord.js');
        const { fillTemplate } = await import('../copilotTemplates.js');
        const { resolveTemplate } = await import('../../handlers/promptTemplate.js');
        const { unescapePlaceholders } = await import('../placeholderEscape.js');
        const { EXECUTE_TODO_USER_MESSAGE_TEMPLATE_BODY } = await import('../sendToChatConfig.js');
        const { EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY } = await import('../explainTodoTemplate.js');
        const fs = await import('fs');
        const path = await import('path');
        const root = path.resolve(__dirname, '..', '..', '..');
        const workspaceConfig = JSON.parse(fs.readFileSync(path.resolve(root, '..', '..', '..', '.tom', 'tom_vscode_extension.json'), 'utf8'));
        const guide = (workspaceConfig.anthropic.userMessageTemplates as Array<{ id: string; template: string }>).find((t) => t.id === 'guide-user-action')?.template;
        assert.ok(guide, 'the workspace has the Guide me template');
        const prompt = buildStackedTodoPrompt([{ ref: REF, yaml: todoSendBlock(REF, todoYamlBlock(TODO, '_ai/quests/q/todos.q.todo.yaml')) }]);
        for (const [name, body] of [['execute-todo', EXECUTE_TODO_USER_MESSAGE_TEMPLATE_BODY], ['explain-todo', EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY], ['guide-user-action', guide!]]) {
            const sent = unescapePlaceholders(resolveTemplate(fillTemplate(body, prompt), { quest: 'q' }));
            assert.ok(sent.includes('Here is the complete YAML of the todo:'), `${name}: the intro`);
            assert.ok(sent.includes('decision: (a)'), `${name}: the decision's answer`);
            assert.ok(sent.includes('Uses `${repeatTodoId}` literally.'), `${name}: the record as stored`);
            assert.ok(sent.includes(`REQUIRED: Add responseValue #TODO=${REF}`), `${name}: the report line`);
        }
        const handler = fs.readFileSync(path.join(root, 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf8');
        assert.equal((handler.match(/_todoPromptFragment\(todo, questId, /g) ?? []).length, 6, 'Send, Add to queue, both stack actions, Guide me in the chat and via the queue');
        assert.match(handler, /\{ query: unescapePlaceholders\(expanded\) \}/);
        assert.match(guide!, /comes with its complete YAML/, 'Guide me works from the record');
    });
});
