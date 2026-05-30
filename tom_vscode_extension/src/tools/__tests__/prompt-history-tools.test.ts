/**
 * Tool-wrapper tests — exercise `listPromptPairsImpl` /
 * `getPromptPairImpl` (the wsRoot-explicit overloads). Confirms the
 * JSON envelope, default questId fallback, and selector-validation.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Install the shared vscode + chatVariablesStore stub BEFORE importing
// the tool module — see _vscode-stub.ts for the contract.
import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';
installVscodeStub({
    moduleOverrides: {
        '../managers/chatVariablesStore': { ChatVariablesStore: { instance: { quest: 'demo_quest' } } },
    },
});

import {
    getPromptPairImpl,
    listPromptPairsImpl,
} from '../prompt-history-tools.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmp: string;
const QUEST_ID = 'demo_quest';

function makeSummaryFile(filePath: string, kind: 'PROMPT' | 'ANSWER', entries: Array<{ id: string; ts: string; seq: number; body: string }>): void {
    const blocks = entries.slice().reverse().map((e) => {
        const header = `=== ${kind} ${e.id} ${e.ts} ${e.seq} ===`;
        if (kind === 'PROMPT') {
            return `${header}\n\n${e.body}\n\nTEMPLATE: (none)\nANSWER-WRAPPER: no\n\n`;
        }
        return `${header}\n\n${e.body}\n\n`;
    });
    fs.writeFileSync(filePath, blocks.join(''), 'utf-8');
}

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-history-tools-'));
    const questFolder = path.join(tmp, '_ai', 'quests', QUEST_ID);
    fs.mkdirSync(questFolder, { recursive: true });

    makeSummaryFile(path.join(questFolder, `${QUEST_ID}.anthropic.prompts.md`), 'PROMPT', [
        { id: 'req-A1', ts: '2026-01-01T10:00:00.000Z', seq: 1, body: 'First prompt.' },
        { id: 'req-A2', ts: '2026-01-01T10:05:00.000Z', seq: 2, body: 'Second prompt with body.' },
    ]);
    makeSummaryFile(path.join(questFolder, `${QUEST_ID}.anthropic.answers.md`), 'ANSWER', [
        { id: 'req-A1', ts: '2026-01-01T10:00:01.000Z', seq: 1, body: 'First answer.' },
        { id: 'req-A2', ts: '2026-01-01T10:05:01.000Z', seq: 2, body: 'Second answer.' },
    ]);
});

after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// listPromptPairsImpl
// ---------------------------------------------------------------------------

describe('listPromptPairsImpl', () => {

    test('returns JSON with pairs newest-first', async () => {
        // Covers entry 33 d) — timing for tomAi_listPromptPairs typical call.
        const r = JSON.parse(await withTiming('tomAi_listPromptPairs:typical', () =>
            listPromptPairsImpl(tmp, { questId: QUEST_ID })));
        assert.equal(r.questId, QUEST_ID);
        assert.equal(r.totalAvailable, 2);
        assert.equal(r.returned, 2);
        assert.deepEqual(r.pairs.map((p: { requestId: string }) => p.requestId), ['req-A2', 'req-A1']);
        // Each pair has the metadata shape we documented
        for (const p of r.pairs) {
            assert.ok('requestId' in p);
            assert.ok('timestamp' in p);
            assert.ok('subsystem' in p);
            assert.ok('promptChars' in p);
            assert.ok('answerChars' in p);
            assert.ok('hasAnswer' in p);
            assert.ok('promptPreview' in p);
            assert.ok('answerPreview' in p);
        }
    });

    test('subsystem filter is forwarded', async () => {
        const r = JSON.parse(await listPromptPairsImpl(tmp, { questId: QUEST_ID, subsystem: 'anthropic' }));
        assert.deepEqual(r.subsystemsScanned, ['anthropic']);
    });

    test('limit + offset paging', async () => {
        const r = JSON.parse(await listPromptPairsImpl(tmp, { questId: QUEST_ID, limit: 1, offset: 1 }));
        assert.equal(r.returned, 1);
        assert.equal(r.pairs[0].requestId, 'req-A1');
    });

    test('default questId uses the ChatVariablesStore stub ("demo_quest")', async () => {
        const r = JSON.parse(await listPromptPairsImpl(tmp, {}));
        assert.equal(r.questId, QUEST_ID);
    });

    test('missing wsRoot returns error JSON', async () => {
        const r = JSON.parse(await listPromptPairsImpl(undefined, { questId: QUEST_ID }));
        assert.match(r.error, /Workspace root not available/);
    });
});

// ---------------------------------------------------------------------------
// getPromptPairImpl
// ---------------------------------------------------------------------------

describe('getPromptPairImpl', () => {

    test('single requestId returns full bodies', async () => {
        // Covers entry 33 d) — timing for tomAi_getPromptPair typical call.
        const r = JSON.parse(await withTiming('tomAi_getPromptPair:typical', () =>
            getPromptPairImpl(tmp, { questId: QUEST_ID, requestId: 'req-A2' })));
        assert.equal(r.pairs.length, 1);
        assert.equal(r.pairs[0].requestId, 'req-A2');
        assert.match(r.pairs[0].promptBody, /Second prompt with body/);
        assert.match(r.pairs[0].answerBody, /Second answer/);
    });

    test('requestIds array preserves order', async () => {
        const r = JSON.parse(await getPromptPairImpl(tmp, { questId: QUEST_ID, requestIds: ['req-A1', 'req-A2'] }));
        assert.deepEqual(r.pairs.map((p: { requestId: string }) => p.requestId), ['req-A1', 'req-A2']);
    });

    test('index without count returns one', async () => {
        const r = JSON.parse(await getPromptPairImpl(tmp, { questId: QUEST_ID, index: 0 }));
        assert.equal(r.pairs.length, 1);
        assert.equal(r.pairs[0].requestId, 'req-A2');  // newest
    });

    test('index + count returns the slice', async () => {
        const r = JSON.parse(await getPromptPairImpl(tmp, { questId: QUEST_ID, index: 0, count: 5 }));
        assert.equal(r.pairs.length, 2);
    });

    test('no selector returns instructive error', async () => {
        const r = JSON.parse(await getPromptPairImpl(tmp, { questId: QUEST_ID }));
        assert.match(r.error, /Provide requestId/);
    });

    test('unknown requestId surfaces in notFoundRequestIds', async () => {
        const r = JSON.parse(await getPromptPairImpl(tmp, { questId: QUEST_ID, requestIds: ['req-A2', 'unknown'] }));
        assert.equal(r.pairs.length, 1);
        assert.deepEqual(r.notFoundRequestIds, ['unknown']);
    });

    test('missing wsRoot returns error JSON', async () => {
        const r = JSON.parse(await getPromptPairImpl(undefined, { questId: QUEST_ID, index: 0 }));
        assert.match(r.error, /Workspace root not available/);
    });
});
