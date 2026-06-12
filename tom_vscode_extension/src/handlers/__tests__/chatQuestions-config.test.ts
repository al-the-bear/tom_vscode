/**
 * Tests for `parseChatQuestionsConfig` — the pure normaliser behind the
 * "Chat questions" settings (`tomAi_askUser`). It must always return a usable
 * config: defaults for missing/wrong-typed fields, and `maxWaitMinutes`
 * clamped to a whole number ≥ 1.
 *
 * `chatQuestions-config.ts` imports `vscode` (for the read/write toasts) and
 * `WsPaths` at module top, so the shared stub is installed before the import.
 * The parse function itself touches neither.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    parseChatQuestionsConfig,
    CHAT_QUESTIONS_DEFAULTS,
} from '../chatQuestions-config.js';

describe('parseChatQuestionsConfig', () => {

    test('undefined / null → defaults', () => {
        assert.deepEqual(parseChatQuestionsConfig(undefined), CHAT_QUESTIONS_DEFAULTS);
        assert.deepEqual(parseChatQuestionsConfig(null), CHAT_QUESTIONS_DEFAULTS);
    });

    test('non-object (string / number) → defaults', () => {
        assert.deepEqual(parseChatQuestionsConfig('nope'), CHAT_QUESTIONS_DEFAULTS);
        assert.deepEqual(parseChatQuestionsConfig(42), CHAT_QUESTIONS_DEFAULTS);
    });

    test('empty object → defaults', () => {
        assert.deepEqual(parseChatQuestionsConfig({}), CHAT_QUESTIONS_DEFAULTS);
    });

    test('valid values are preserved', () => {
        const cfg = parseChatQuestionsConfig({ maxWaitMinutes: 30, fallbackPrompt: 'do your best' });
        assert.equal(cfg.maxWaitMinutes, 30);
        assert.equal(cfg.fallbackPrompt, 'do your best');
    });

    test('maxWaitMinutes is floored to a whole number', () => {
        assert.equal(parseChatQuestionsConfig({ maxWaitMinutes: 7.9 }).maxWaitMinutes, 7);
    });

    test('maxWaitMinutes below 1 is clamped to 1', () => {
        assert.equal(parseChatQuestionsConfig({ maxWaitMinutes: 0 }).maxWaitMinutes, 1);
        assert.equal(parseChatQuestionsConfig({ maxWaitMinutes: -5 }).maxWaitMinutes, 1);
        assert.equal(parseChatQuestionsConfig({ maxWaitMinutes: 0.4 }).maxWaitMinutes, 1);
    });

    test('non-finite / wrong-typed maxWaitMinutes → default minutes', () => {
        assert.equal(
            parseChatQuestionsConfig({ maxWaitMinutes: Number.NaN }).maxWaitMinutes,
            CHAT_QUESTIONS_DEFAULTS.maxWaitMinutes,
        );
        assert.equal(
            parseChatQuestionsConfig({ maxWaitMinutes: 'fifteen' }).maxWaitMinutes,
            CHAT_QUESTIONS_DEFAULTS.maxWaitMinutes,
        );
    });

    test('blank / wrong-typed fallbackPrompt → default prompt', () => {
        assert.equal(
            parseChatQuestionsConfig({ fallbackPrompt: '   ' }).fallbackPrompt,
            CHAT_QUESTIONS_DEFAULTS.fallbackPrompt,
        );
        assert.equal(
            parseChatQuestionsConfig({ fallbackPrompt: 123 }).fallbackPrompt,
            CHAT_QUESTIONS_DEFAULTS.fallbackPrompt,
        );
    });

    test('partial config fills only the missing field', () => {
        const cfg = parseChatQuestionsConfig({ maxWaitMinutes: 20 });
        assert.equal(cfg.maxWaitMinutes, 20);
        assert.equal(cfg.fallbackPrompt, CHAT_QUESTIONS_DEFAULTS.fallbackPrompt);
    });
});
