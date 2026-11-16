/**
 * The seeded user-message templates (vscimpb120, userMessageTemplateSeeds.ts):
 *
 *   UT-1 With asking: seeded, wraps `${userMessage}`, asks every unclear point through the three ask tools
 *        without `timeoutMinutes`, decision-needed todos only for what the user leaves open
 *   UT-2 every seeded template names the ask tools: Execute TODO (the ask-tools paragraph), Explain TODO
 *        (tomAi_askInMdBrowser in a Markdown document)
 *   UT-3 the seeding: an unedited earlier Execute / Explain body is brought to the current one, an edited one is
 *        left alone, With asking is added once; idempotent
 *   UT-4 with-context and with-role-banner are removed; a default flag on one moves to default-raw; a todo-button
 *        setting naming one is dropped; a reference to one resolves to default-raw
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

installVscodeStub({ workspaceFolders: [process.cwd()] });

import {
    ASK_TOOLS_PARAGRAPH, PREVIOUS_EXECUTE_TODO_BODIES, RETIRED_USER_MESSAGE_TEMPLATE_IDS, WITH_ASKING_USER_MESSAGE_TEMPLATE_BODY,
    WITH_ASKING_USER_MESSAGE_TEMPLATE_ID, ensureSeededUserMessageTemplates, liveUserMessageTemplateId,
} from '../userMessageTemplateSeeds.js';
import { EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY, PREVIOUS_EXPLAIN_TODO_BODIES } from '../explainTodoTemplate.js';
import { userMessageTemplateBody } from '../copilotTemplates.js';

const ASK_TOOLS = ['tomAi_askUser', 'tomAi_askUserPicker', 'tomAi_askInMdBrowser'];

describe('seeded user-message templates', () => {
    test('UT-1: With asking', () => {
        assert.equal(WITH_ASKING_USER_MESSAGE_TEMPLATE_ID, 'with-asking');
        assert.match(WITH_ASKING_USER_MESSAGE_TEMPLATE_BODY, /\$\{userMessage\}/);
        for (const tool of ASK_TOOLS) { assert.ok(WITH_ASKING_USER_MESSAGE_TEMPLATE_BODY.includes(`\`${tool}\``), tool); }
        assert.match(WITH_ASKING_USER_MESSAGE_TEMPLATE_BODY, /Before you do anything[\s\S]*all of them at once/);
        assert.match(WITH_ASKING_USER_MESSAGE_TEMPLATE_BODY, /without `timeoutMinutes`/);
        assert.match(WITH_ASKING_USER_MESSAGE_TEMPLATE_BODY, /decision-needed todos only for what I explicitly leave open/);
    });

    test('UT-2: every seeded template names the ask tools', async () => {
        for (const tool of ASK_TOOLS) { assert.ok(ASK_TOOLS_PARAGRAPH.includes(`\`${tool}\``), tool); }
        const { EXECUTE_TODO_USER_MESSAGE_TEMPLATE_BODY } = await import('../sendToChatConfig.js');
        assert.equal(EXECUTE_TODO_USER_MESSAGE_TEMPLATE_BODY, `${PREVIOUS_EXECUTE_TODO_BODIES[0]}\n\n${ASK_TOOLS_PARAGRAPH}`, 'Execute TODO = its earlier body + the ask-tools paragraph');
        assert.match(EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY, /Ask me in a Markdown document through `tomAi_askInMdBrowser`/);
        assert.match(EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY, /`tomAi_mdInsertQuestion`[\s\S]*`tomAi_mdQuestions`/);
        assert.match(EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY, /without `timeoutMinutes`/);
        assert.doesNotMatch(EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY, /Ask me through `tomAi_askUser`/);
        assert.match(PREVIOUS_EXPLAIN_TODO_BODIES[0], /Ask me through `tomAi_askUser`/, 'the earlier body is the one before vscimpb120');
    });

    test('UT-3: the seeding upgrades unedited bodies once and leaves edited ones', async () => {
        const { EXECUTE_TODO_USER_MESSAGE_TEMPLATE_BODY } = await import('../sendToChatConfig.js');
        const config = { anthropic: { userMessageTemplates: [
            { id: 'default-raw', name: 'Raw', template: '${userMessage}' },
            { id: 'execute-todo', name: 'Execute TODO', template: PREVIOUS_EXECUTE_TODO_BODIES[0] },
            { id: 'explain-todo', name: 'Explain TODO', template: PREVIOUS_EXPLAIN_TODO_BODIES[0] },
        ] } };
        const changes = ensureSeededUserMessageTemplates(config, EXECUTE_TODO_USER_MESSAGE_TEMPLATE_BODY);
        assert.deepEqual(changes, ['added "With asking"', 'Execute TODO: the built-in text brought up to date', 'Explain TODO: the built-in text brought up to date']);
        const byId = (id: string) => config.anthropic.userMessageTemplates.find((t) => t.id === id)!;
        assert.equal(byId('execute-todo').template, EXECUTE_TODO_USER_MESSAGE_TEMPLATE_BODY);
        assert.equal(byId('explain-todo').template, EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY);
        assert.equal(byId('with-asking').template, WITH_ASKING_USER_MESSAGE_TEMPLATE_BODY);
        assert.deepEqual(ensureSeededUserMessageTemplates(config, EXECUTE_TODO_USER_MESSAGE_TEMPLATE_BODY), [], 'idempotent');

        const edited = { anthropic: { userMessageTemplates: [{ id: 'execute-todo', template: 'my own text ${userMessage}' }, { id: 'with-asking', template: 'mine too' }] } };
        assert.deepEqual(ensureSeededUserMessageTemplates(edited, EXECUTE_TODO_USER_MESSAGE_TEMPLATE_BODY), []);
        assert.equal(edited.anthropic.userMessageTemplates[0].template, 'my own text ${userMessage}', 'an edited body stays');
        assert.equal(edited.anthropic.userMessageTemplates[1].template, 'mine too');
    });

    test('UT-4: the retired templates', () => {
        assert.deepEqual([...RETIRED_USER_MESSAGE_TEMPLATE_IDS], ['with-context', 'with-role-banner']);
        const config = { anthropic: {
            userMessageTemplates: [
                { id: 'default-raw', name: 'Raw', template: '${userMessage}' },
                { id: 'with-context', name: 'Ctx', template: 'ctx ${userMessage}' },
                { id: 'with-role-banner', name: 'Banner', template: 'banner ${userMessage}', isDefault: true },
                { id: 'with-asking', template: 'x' },
            ],
            todoButtonTemplates: { other: 'with-role-banner', userAction: 'guide-user-action' } as Record<string, string | undefined>,
        } };
        const changes = ensureSeededUserMessageTemplates(config, 'exec');
        assert.ok(changes.includes('removed "with-context", "with-role-banner"'), JSON.stringify(changes));
        assert.deepEqual(config.anthropic.userMessageTemplates.map((t) => t.id), ['default-raw', 'with-asking']);
        assert.equal((config.anthropic.userMessageTemplates[0] as { isDefault?: boolean }).isDefault, true, 'the default flag moves to default-raw');
        assert.deepEqual(config.anthropic.todoButtonTemplates, { userAction: 'guide-user-action' }, 'a button naming a retired one falls back to its default');

        assert.equal(liveUserMessageTemplateId('with-context'), 'default-raw');
        assert.equal(liveUserMessageTemplateId('execute-todo'), 'execute-todo');
        // A queue item or timed request still naming one gets default-raw's body.
        assert.equal(userMessageTemplateBody(config, 'with-role-banner'), '${userMessage}');
        assert.equal(userMessageTemplateBody(config, 'with-asking'), 'x');
    });
});
