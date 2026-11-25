/**
 * The Quest TODO "Send to Chat" button offers the one template store.
 * `buildTodoSendTemplateChoices` is the pure decision: which templates to offer
 * (Run default first and preselected).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

installVscodeStub({ workspaceFolders: [process.cwd()] });

describe('buildTodoSendTemplateChoices', () => {
    const store = { anthropic: { userMessageTemplates: [{ id: 'execute-todo', name: 'Execute TODO' }, { id: 'explain-todo', name: 'Explain TODO', isDefault: true }] } };

    it('offers Run default, (None) and the one template store, no wrapper option', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        for (const transport of ['anthropic'] as const) {
            const choices = buildTodoSendTemplateChoices(transport, store);
            assert.equal(choices.transport, transport);
            assert.deepEqual(choices.templates.map((t) => t.id), ['__run_default__', '__none__', 'execute-todo', 'explain-todo']);
            assert.ok(!choices.templates.some((t) => t.id === '__answer_file__'), 'the wrapper is not a template choice');
            assert.equal(choices.templates.find((t) => t.id === 'explain-todo')?.label, 'Explain TODO', 'labels come from the template name');
        }
    });

    it('Run default is preselected, whatever template is flagged isDefault', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        assert.equal(buildTodoSendTemplateChoices('anthropic', store).selected, '__run_default__');
        assert.equal(buildTodoSendTemplateChoices('anthropic', store, 'execute-todo').selected, '__run_default__');
    });

    it('the Run default label names the run\'s template', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        assert.equal(buildTodoSendTemplateChoices('anthropic', store, 'execute-todo').templates[0].label, 'Run default (Execute TODO)');
        assert.equal(buildTodoSendTemplateChoices('anthropic', store, 'gone').templates[0].label, 'Run default (gone)');
        assert.equal(buildTodoSendTemplateChoices('anthropic', store).templates[0].label, 'Run default (no template)');
    });

    it('no templates: Run default and (None)', async () => {
        const { buildTodoSendTemplateChoices } = await import('../todoSendTargets.js');
        const choices = buildTodoSendTemplateChoices('anthropic', {});
        assert.deepEqual(choices.templates.map((t) => t.id), ['__run_default__', '__none__']);
        assert.equal(choices.selected, '__run_default__');
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
 *        record arrives, a `${…}` in it as written; the panel builds every send from this block
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
        const { fillTemplate } = await import('../userMessageTemplateLookup.js');
        const { resolveTemplate } = await import('../../handlers/promptTemplate.js');
        const { unescapePlaceholders } = await import('../placeholderEscape.js');
        const { EXECUTE_TODO_USER_MESSAGE_TEMPLATE_BODY } = await import('../sendToChatConfig.js');
        const { EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY } = await import('../explainTodoTemplate.js');
        const fs = await import('fs');
        const path = await import('path');
        const { rootTomPath, EXTENSION_DIR: root } = await import('./_layoutRoot.js');
        // The configuration is the root's (utils/workspaceLayout.ts), wherever the root is.
        const workspaceConfig = JSON.parse(fs.readFileSync(rootTomPath('tom_vscode_extension.json'), 'utf8'));
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
        assert.equal((handler.match(/_todoPromptFragment\(todo, questId, /g) ?? []).length, 6, 'Send, Add to queue, both stack actions, Guide me in the chat and via the queue (Queue again re-delivers the same entries, vscimpb139)');
        assert.match(guide!, /comes with its complete YAML/, 'Guide me works from the record');
    });
});
