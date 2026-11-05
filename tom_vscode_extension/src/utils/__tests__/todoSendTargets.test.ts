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

    it('multiple todos: fragments concatenate into ONE yaml list, in stack order', async () => {
        const { buildStackedTodoPrompt } = await import('../todoSendTargets.js');
        const prompt = buildStackedTodoPrompt([
            { yaml: '- id: f/a.todo.yaml/A\n  title: A', ref: 'f/a.todo.yaml/A' },
            { yaml: '- id: f/a.todo.yaml/B\n  title: B', ref: 'f/a.todo.yaml/B' },
            { yaml: '- id: f/b.todo.yaml/C\n  title: C', ref: 'f/b.todo.yaml/C' },
        ]);
        const yamlBlock = prompt.split('\n\nREQUIRED')[0];
        assert.equal(
            yamlBlock,
            '- id: f/a.todo.yaml/A\n  title: A\n- id: f/a.todo.yaml/B\n  title: B\n- id: f/b.todo.yaml/C\n  title: C',
            'fragments join with a single newline so they form one valid yaml list',
        );
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
