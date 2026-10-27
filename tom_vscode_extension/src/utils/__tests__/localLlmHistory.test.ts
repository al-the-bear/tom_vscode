/**
 * Where a Local LLM profile keeps its history (src/utils/localLlmHistory.ts).
 *
 *   LH-1 a profile's own historySuffix is used; without one (unset, empty, blank) the Local LLM default
 *        `localLLM`, so no Local LLM profile writes the plain `history.json` (the Anthropic history before sessions)
 *   LH-2 the handler takes the suffix through it for both reading and writing (its source is read: it imports vscode)
 *   LH-3 the snapshot names: `history-<suffix>.json` beside the session folders, never `history.json`
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_LOCAL_LLM_HISTORY_SUFFIX, localLlmHistorySuffix } from '../localLlmHistory.js';

function source(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf-8');
}

describe('Local LLM history location', () => {
    test('LH-1: the suffix', () => {
        assert.equal(DEFAULT_LOCAL_LLM_HISTORY_SUFFIX, 'localLLM');
        assert.equal(localLlmHistorySuffix('gemma4-bomber'), 'gemma4-bomber');
        assert.equal(localLlmHistorySuffix(' qwen '), 'qwen');
        for (const none of [undefined, null, '', '   ']) {
            assert.equal(localLlmHistorySuffix(none), 'localLLM', JSON.stringify(none));
        }
    });

    test('LH-2: the handler reads and writes with it', () => {
        const handler = source('src', 'handlers', 'localLlm-handler.ts');
        assert.match(handler, /const historySuffix = localLlmHistorySuffix\(profile\?\.historySuffix\);/);
        assert.match(handler, /this\.seedHistoryFromSnapshot\(questForHistory, historySuffix\);/);
        assert.match(handler, /this\.persistSessionHistory\(questForHistory, historySuffix\);/);
        assert.doesNotMatch(handler, /seedHistoryFromSnapshot\(questForHistory, profile/, 'no path around the default');
    });

    test('LH-3: the file names', () => {
        // memory-service writes `history-<suffix>.{json,md}` for a suffix, `history.{json,md}` without one.
        const memory = source('src', 'services', 'memory-service.ts');
        assert.match(memory, /const base = suffix \? `history-\$\{suffix\}` : 'history';/);
        assert.equal(`history-${localLlmHistorySuffix(undefined)}.json`, 'history-localLLM.json');
    });
});
