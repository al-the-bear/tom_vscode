/**
 * A direct send's usage into the ledger round by round (dapieff2): each
 * round's usage reaches the ledger as its response arrives, so a send that
 * ends in an error (out of credit, a 400, a cancel) still shows what it used —
 * in the ledger and in the live trail's usage block — and a send that
 * succeeds is counted once (src/utils/usageCost.ts DirectSendUsage,
 * src/services/usageLedgerService.ts).
 *
 *   UC-9  two rounds: the ledger has one send with both rounds' tokens and cost, recorded before the send ends;
 *         the send's usage block (the totals, marked recordedInLedger) is not counted again by the observer
 *   UC-10 a send that fails after one round: the ledger has that round, the live trail its usage block
 *   UC-11 a block from another transport (not marked) is still counted by the observer; a round without
 *         usage records nothing; the ledger's countSend: false adds tokens and cost without a send
 *   UC-12 the direct loop: every response goes into DirectSendUsage, and the error path writes the usage block
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-rounds-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { LiveTrailWriter } from '../live-trail.js';
import { registerUsageLedger, recordRoundUsage, usageSummary } from '../usageLedgerService.js';
import { DirectSendUsage, directSendUsage, type ModelPrice } from '../../utils/usageCost.js';
import { emptyUsageLedger, recordUsage, summarizeUsage } from '../../utils/usageLedger.js';

const MODEL = 'claude-opus-5-5';
const PRICES: ModelPrice[] = [{ model: 'claude-opus-5', inputPerMTok: 15, outputPerMTok: 75 }];
const ROUND1 = { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 500 };
const ROUND2 = { inputTokens: 300, outputTokens: 100, cacheReadInputTokens: 1500, cacheCreationInputTokens: 0 };

const state = new Map<string, unknown>();
const disposables: Array<{ dispose(): void }> = [];
const context = {
    subscriptions: disposables,
    workspaceState: {
        get: (k: string) => state.get(k),
        update: async (k: string, v: unknown) => { state.set(k, v); },
    },
};

const row = () => usageSummary()?.today.find((r) => r.model === MODEL);

describe('direct send usage, round by round', () => {
    before(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        registerUsageLedger(context as any);
    });
    after(() => {
        for (const d of disposables) { d.dispose(); }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('UC-9: two rounds — one send, both rounds, no double count', () => {
        state.clear();
        const send = new DirectSendUsage(MODEL, PRICES, recordRoundUsage);
        send.addRound(ROUND1);
        assert.deepEqual([row()?.sends, row()?.inputTokens], [1, 1000], 'the first round is in the ledger before the send ends');
        send.addRound(ROUND2);
        const mid = row();
        assert.deepEqual([mid?.sends, mid?.inputTokens, mid?.outputTokens, mid?.cacheReadInputTokens, mid?.cacheCreationInputTokens],
            [1, 1300, 300, 1500, 500]);
        const block = send.sendUsage();
        assert.equal(block?.recordedInLedger, true);
        assert.deepEqual(block?.totals, send.totals);
        const whole = directSendUsage(MODEL, send.totals, PRICES).totalCostUsd ?? NaN;
        assert.ok(Math.abs((mid?.costUsd ?? 0) - whole) < 1e-9, 'the rounds\' costs add up to the send\'s');
        assert.ok(Math.abs((block?.totalCostUsd ?? 0) - whole) < 1e-9);

        const writer = new LiveTrailWriter('usageq', 'live-trail.md', 'default');
        writer.beginPrompt({ transport: 'direct', config: 'c', userText: 'go' });
        writer.appendUsage(block!);
        const after = row();
        assert.deepEqual([after?.sends, after?.inputTokens, after?.costUsd], [mid?.sends, mid?.inputTokens, mid?.costUsd], 'the block is not counted again');
    });

    test('UC-10: a send that fails after one round still shows what it used', () => {
        state.clear();
        const send = new DirectSendUsage(MODEL, PRICES, recordRoundUsage);
        send.addRound(ROUND1);
        // round 2 throws (out of credit): no response, nothing to add
        const writer = new LiveTrailWriter('usageq', 'live-trail.md', 'failed');
        writer.beginPrompt({ transport: 'direct', config: 'c', userText: 'go' });
        writer.appendUsage(send.sendUsage()!);
        writer.endPromptWithError('400 credit balance too low');
        assert.deepEqual([row()?.sends, row()?.inputTokens, row()?.outputTokens], [1, 1000, 200]);
        const file = fs.readFileSync(writer.getFilePath(), 'utf8');
        assert.match(file, /1,000/, 'the usage block is in the live trail');
        assert.ok(file.indexOf('1,000') < file.indexOf('credit balance'), 'before the error');
    });

    test('UC-11: other transports, empty rounds, the ledger option', () => {
        state.clear();
        const writer = new LiveTrailWriter('usageq', 'live-trail.md', 'other');
        writer.appendUsage(directSendUsage(MODEL, ROUND1, PRICES));
        assert.deepEqual([row()?.sends, row()?.inputTokens], [1, 1000], 'an unmarked block (Agent SDK, Local LLM) is counted by the observer');

        const calls: boolean[] = [];
        const send = new DirectSendUsage(MODEL, PRICES, (_u, first) => calls.push(first));
        send.addRound({});
        assert.deepEqual([calls, send.sendUsage()], [[], undefined], 'a round without usage records nothing');
        send.addRound(ROUND1); send.addRound(ROUND2); send.addRound(ROUND2);
        assert.deepEqual(calls, [true, false, false]);

        const now = new Date();
        let ledger = recordUsage(emptyUsageLedger(now), directSendUsage('m', ROUND1, undefined), now);
        ledger = recordUsage(ledger, directSendUsage('m', ROUND2, undefined), now, { countSend: false });
        const r = summarizeUsage(ledger, now).today[0];
        assert.deepEqual([r.sends, r.unpricedSends, r.inputTokens], [1, 1, 1300], 'a later round adds tokens, not a send');
    });

    test('UC-12: the direct loop', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'anthropic-handler.ts'), 'utf8');
        const start = src.indexOf('const sendUsage = new DirectSendUsage(');
        assert.ok(start > 0);
        const loop = src.slice(start, src.indexOf('private async sendViaVsCodeLm', start));
        assert.match(loop, /new DirectSendUsage\(configuration\.model, [^,]+, recordRoundUsage\)/);
        assert.match(loop, /sendUsage\.addRound\(addResponseUsage\(\{\}, response\.usage\)\)/, 'each response, as it arrives');
        assert.match(loop, /finishUsage\(\);\s*closeLiveTrailForThrown\(liveTrail, err, errMsg\);/, 'the error path writes the usage block first');
        assert.match(loop, /if \(!usageReported\)/, 'the block is written once');
    });
});
