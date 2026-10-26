/**
 * A quest can override the workspace's compaction settings in its own
 * `extension_config.<quest>.yaml` (section `compaction`), so compaction can be
 * switched on — or pointed at another model — for one quest while the
 * workspace setting stays as it is for every other quest.
 *
 *   CQ-1 no quest section: the workspace settings, unchanged
 *   CQ-2 the quest section overrides disabled, llmProvider, llmConfigId and the other known keys
 *   CQ-3 a value of the wrong type, an unknown provider or an unknown key is ignored
 *   CQ-4 the handler reads the quest section of the window's quest
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyQuestCompactionOverride, SECTION_COMPACTION } from '../compactionQuestOverride.js';

const GLOBAL = {
    disabled: true,
    llmProvider: 'localLlm' as 'localLlm' | 'anthropic',
    llmConfigId: 'bomber-gemma4-26b-8001',
    runEveryNRounds: 15,
    rawTurnsKept: 4,
    maxHistoryTokens: 16000,
    runMemoryExtractionOnCompaction: true,
};

describe('applyQuestCompactionOverride', () => {
    test('CQ-1: no quest section', () => {
        assert.deepEqual(applyQuestCompactionOverride(GLOBAL, undefined), GLOBAL);
        assert.deepEqual(applyQuestCompactionOverride(GLOBAL, 'text'), GLOBAL);
    });

    test('CQ-2: the quest section overrides', () => {
        const out = applyQuestCompactionOverride(GLOBAL, {
            disabled: false, llmProvider: 'anthropic', llmConfigId: 'haiku-5-5-direct', runEveryNRounds: 10,
        });
        assert.deepEqual(out, { ...GLOBAL, disabled: false, llmProvider: 'anthropic', llmConfigId: 'haiku-5-5-direct', runEveryNRounds: 10 });
        assert.equal(GLOBAL.disabled, true, 'the workspace settings object is not changed');
    });

    test('CQ-3: wrong values are ignored', () => {
        const out = applyQuestCompactionOverride(GLOBAL, {
            disabled: 'no', llmProvider: 'openai', llmConfigId: 7, runEveryNRounds: -1, colour: 'red',
        });
        assert.deepEqual(out, GLOBAL);
    });

    test('CQ-4: the handler applies the quest section', () => {
        assert.equal(SECTION_COMPACTION, 'compaction');
        const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf-8');
        assert.match(src, /applyQuestCompactionOverride\(/);
        assert.match(src, /readQuestSection\(SECTION_COMPACTION/);
    });
});
