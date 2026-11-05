/**
 * Feature 6: an "Execute TODO" Anthropic user-message template, modeled on the
 * Copilot "TODO Execution" built-in. `ensureExecuteTodoUserMessageTemplate`
 * seeds it into `config.anthropic.userMessageTemplates` on activation, the same
 * way `ensureDefaultTransportRetryTemplate` seeds the retry default.
 *
 * The seed must be idempotent (no duplicate on a second pass), must NOT force
 * itself as the default user-message template (it only adds an option), and the
 * body must wrap the Anthropic `${userMessage}` placeholder — not the Copilot
 * `${originalPrompt}` one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

installVscodeStub({ workspaceFolders: [process.cwd()] });

describe('ensureExecuteTodoUserMessageTemplate', () => {
    it('appends the Execute TODO template when none exists', async () => {
        const mod = await import('../sendToChatConfig.js');
        const config = {} as import('../sendToChatConfig.js').SendToChatConfig;

        const changed = mod.ensureExecuteTodoUserMessageTemplate(config);

        assert.equal(changed, true, 'should report a mutation on first seed');
        const templates = config.anthropic?.userMessageTemplates ?? [];
        const entry = templates.find((t) => t.id === mod.EXECUTE_TODO_USER_MESSAGE_TEMPLATE_ID);
        assert.ok(entry, 'expected the Execute TODO template to be appended');
        assert.equal(entry!.name, mod.EXECUTE_TODO_USER_MESSAGE_TEMPLATE_NAME);
        assert.match(entry!.template, /\$\{userMessage\}/, 'must use the anthropic ${userMessage} placeholder');
        assert.doesNotMatch(entry!.template, /\$\{originalPrompt\}/, 'must not use the copilot placeholder');
        assert.notEqual(entry!.isDefault, true, 'must not force itself as the default template');
    });

    it('is idempotent — a second pass adds nothing and reports no change', async () => {
        const mod = await import('../sendToChatConfig.js');
        const config = {} as import('../sendToChatConfig.js').SendToChatConfig;

        assert.equal(mod.ensureExecuteTodoUserMessageTemplate(config), true);
        assert.equal(mod.ensureExecuteTodoUserMessageTemplate(config), false, 'second pass should be a no-op');

        const matches = (config.anthropic?.userMessageTemplates ?? []).filter(
            (t) => t.id === mod.EXECUTE_TODO_USER_MESSAGE_TEMPLATE_ID,
        );
        assert.equal(matches.length, 1, 'must not duplicate the seeded template');
    });

    it('preserves existing user-message templates and their default flag', async () => {
        const mod = await import('../sendToChatConfig.js');
        const config = {
            anthropic: {
                userMessageTemplates: [
                    { id: 'mine', name: 'Mine', template: '${userMessage}', isDefault: true },
                ],
            },
        } as import('../sendToChatConfig.js').SendToChatConfig;

        const changed = mod.ensureExecuteTodoUserMessageTemplate(config);

        assert.equal(changed, true);
        const templates = config.anthropic?.userMessageTemplates ?? [];
        assert.equal(templates.length, 2, 'should keep the user template and add the seed');
        assert.equal(templates.find((t) => t.id === 'mine')?.isDefault, true, 'existing default untouched');
        assert.notEqual(
            templates.find((t) => t.id === mod.EXECUTE_TODO_USER_MESSAGE_TEMPLATE_ID)?.isDefault,
            true,
        );
    });
});

describe('ensureExplainTodoUserMessageTemplate', () => {
    it('seeds Explain TODO once, as an option, wrapping ${userMessage}', async () => {
        const mod = await import('../sendToChatConfig.js');
        const config = { anthropic: { userMessageTemplates: [{ id: 'mine', name: 'Mine', template: '${userMessage}', isDefault: true }] } } as import('../sendToChatConfig.js').SendToChatConfig;
        assert.equal(mod.ensureExplainTodoUserMessageTemplate(config), true);
        assert.equal(mod.ensureExplainTodoUserMessageTemplate(config), false, 'second pass is a no-op');
        const entry = config.anthropic!.userMessageTemplates!.find((t) => t.id === mod.EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_ID)!;
        assert.equal(mod.EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_ID, 'explain-todo');
        assert.equal(entry.name, 'Explain TODO');
        assert.notEqual(entry.isDefault, true);
        assert.equal(config.anthropic!.userMessageTemplates!.find((t) => t.id === 'mine')?.isDefault, true);
        assert.match(entry.template, /\$\{userMessage\}/);
        assert.doesNotMatch(entry.template, /\$\{originalPrompt\}/);
    });

    it('explains, asks through tomAi_askUser and changes only the todo', async () => {
        const { EXPLAIN_TODO_USER_MESSAGE_TEMPLATE_BODY: body } = await import('../explainTodoTemplate.js');
        for (const part of [/what it changes/, /why/, /open decisions/, /tomAi_askUser/, /tomAi_updateQuestTodo/, /decisions\[\]\.decision/, /notes/, /Do not start the work/, /not-started/]) {
            assert.match(body, part);
        }
        assert.match(body, /do not report its TODO response value/, 'the todo is not done by explaining it');
    });
});

