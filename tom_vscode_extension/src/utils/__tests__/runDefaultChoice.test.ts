/**
 * "Run default" in the pickers (src/utils/runDefaultChoice.ts).
 *
 *   RDC-1 the template of an item: "(Run default)" (and the picker value) resolves to the run's template, else
 *         "(None)"; any other template stays; a picker value becomes what an item stores
 *   RDC-2 a send that runs now resolves "Run default" to the run's value; the labels name it
 *   RDC-3 the one-time switch of the chat panel's drafts to Run default keeps everything else
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    chatDraftsOnRunDefault, isRunDefaultChoice, isRunDefaultTemplate, itemTemplateLabel, itemTemplateOfChoice,
    resolveItemTemplate, resolveRunDefaultChoice, runDefaultLabel, RUN_DEFAULT_CHOICE, RUN_DEFAULT_TEMPLATE,
} from '../runDefaultChoice';

describe('run default choice', () => {
    test('RDC-1: item templates', () => {
        assert.equal(RUN_DEFAULT_CHOICE, '__run_default__');
        assert.equal(isRunDefaultChoice('__run_default__'), true);
        assert.equal(isRunDefaultChoice(''), false);
        assert.equal(isRunDefaultTemplate(RUN_DEFAULT_TEMPLATE), true);
        assert.equal(isRunDefaultTemplate(RUN_DEFAULT_CHOICE), true);
        assert.equal(resolveItemTemplate(RUN_DEFAULT_TEMPLATE, 'execute-todo'), 'execute-todo');
        assert.equal(resolveItemTemplate(RUN_DEFAULT_CHOICE, ' '), '(None)');
        assert.equal(resolveItemTemplate('fast', 'execute-todo'), 'fast');
        assert.equal(resolveItemTemplate(undefined, 'execute-todo'), undefined);
        assert.equal(itemTemplateOfChoice(RUN_DEFAULT_CHOICE), RUN_DEFAULT_TEMPLATE);
        assert.equal(itemTemplateOfChoice('__none__'), undefined);
        assert.equal(itemTemplateOfChoice(''), undefined);
        assert.equal(itemTemplateOfChoice('fast'), 'fast');
        assert.equal(itemTemplateLabel(RUN_DEFAULT_TEMPLATE, 'execute-todo'), 'Run default (execute-todo)');
        assert.equal(itemTemplateLabel(RUN_DEFAULT_TEMPLATE, ''), 'Run default (no template)');
        assert.equal(itemTemplateLabel(undefined, 'x'), '(None)');
    });

    test('RDC-2: a send now', () => {
        assert.equal(resolveRunDefaultChoice(RUN_DEFAULT_CHOICE, 'opus'), 'opus');
        assert.equal(resolveRunDefaultChoice(RUN_DEFAULT_CHOICE, undefined), '');
        assert.equal(resolveRunDefaultChoice(RUN_DEFAULT_CHOICE, '', '__none__'), '__none__');
        assert.equal(resolveRunDefaultChoice('fast', 'opus'), 'fast');
        assert.equal(resolveRunDefaultChoice(undefined, 'opus'), '');
        assert.equal(runDefaultLabel('work@r2'), 'Run default (work@r2)');
        assert.equal(runDefaultLabel('', 'no template'), 'Run default (no template)');
    });

    test('RDC-3: the chat panel drafts', () => {
        const drafts = { copilot: { text: 'hi', profile: 'fast' }, anthropic: { text: 'x', profile: 'opus', userMessageTemplate: 'fast' } };
        const out = chatDraftsOnRunDefault(drafts);
        assert.deepEqual(out, {
            copilot: { text: 'hi', profile: RUN_DEFAULT_CHOICE },
            anthropic: { text: 'x', profile: 'opus', userMessageTemplate: RUN_DEFAULT_CHOICE },
        }, 'the templates switch, the Anthropic profile stays');
        assert.equal(drafts.copilot.profile, 'fast', 'the input is not changed');
        assert.deepEqual(chatDraftsOnRunDefault({}), { copilot: { profile: RUN_DEFAULT_CHOICE }, anthropic: { userMessageTemplate: RUN_DEFAULT_CHOICE } });
    });
});
