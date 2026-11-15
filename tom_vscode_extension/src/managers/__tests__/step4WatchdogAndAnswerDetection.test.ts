import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildAnswerFilePath,
    shouldWatchAnswerFile,
    extractRequestIdFromAnswerFilename,
    findMatchingAnswerFile,
    resolveDetectedRequestId,
    computeHealthCheckDecisions,
    windowAnswerFileStem,
    answerFileClaim,
    ownsAnswerFile,
} from '../../utils/queueStep4Utils.js';

describe('Step 4 - Issue 7: requestId-based answer detection', () => {
    test('buildAnswerFilePath uses requestId when available', () => {
        const path = buildAnswerFilePath({
            folder: '/tmp/answers',
            sessionId: 'session-abcdef12',
            machineId: 'machine-34567890',
            requestId: 'abc123',
        });
        assert.equal(path, '/tmp/answers/abc123_answer.json');
    });

    test('buildAnswerFilePath falls back to session_machine when requestId missing', () => {
        const path = buildAnswerFilePath({
            folder: '/tmp/answers',
            sessionId: 'session-abcdef12',
            machineId: 'machine-34567890',
        });
        assert.equal(path, '/tmp/answers/session-_machine-_answer.json');
    });

    test('shouldWatchAnswerFile accepts *_answer.json only', () => {
        assert.equal(shouldWatchAnswerFile('abc_answer.json'), true);
        assert.equal(shouldWatchAnswerFile('abc.txt'), false);
        assert.equal(shouldWatchAnswerFile(undefined), false);
    });

    test('extractRequestIdFromAnswerFilename parses requestId prefix', () => {
        assert.equal(extractRequestIdFromAnswerFilename('abc123_answer.json'), 'abc123');
        assert.equal(extractRequestIdFromAnswerFilename('badname.json'), undefined);
    });

    test('findMatchingAnswerFile returns file with expected requestId prefix', () => {
        const match = findMatchingAnswerFile(['x_answer.json', 'req9_answer.json'], 'req9');
        assert.equal(match, 'req9_answer.json');
    });

    test('findMatchingAnswerFile matches the whole request id, not a prefix', () => {
        assert.equal(findMatchingAnswerFile(['req10_answer.json'], 'req1'), undefined);
        assert.equal(findMatchingAnswerFile(['req10_answer.json', 'req1_answer.json'], 'req1'), 'req1_answer.json');
    });

    test('resolveDetectedRequestId takes a window-named file\'s id from its content only', () => {
        const stem = windowAnswerFileStem('87dae86e-aaaa', '89f7e0a0-bbbb');
        assert.equal(stem, '87dae86e_89f7e0a0');
        assert.deepEqual(resolveDetectedRequestId(stem, 'req-a', stem), { requestId: 'req-a', source: 'content' });
        assert.deepEqual(resolveDetectedRequestId(stem, undefined, stem), { requestId: undefined, source: 'none' });
        assert.deepEqual(resolveDetectedRequestId('req-b', 'req-a', stem), { requestId: 'req-b', source: 'filename' });
    });

    test('resolveDetectedRequestId prefers filename requestId over content requestId', () => {
        const detected = resolveDetectedRequestId('filenameRid', 'contentRid');
        assert.equal(detected.requestId, 'filenameRid');
        assert.equal(detected.source, 'filename');
    });

    test('resolveDetectedRequestId falls back to content requestId when filename is missing', () => {
        const detected = resolveDetectedRequestId(undefined, 'contentRid');
        assert.equal(detected.requestId, 'contentRid');
        assert.equal(detected.source, 'content');
    });
});

describe('Step 4 - Issue 6: health check decisions', () => {
    test('requests sendNext when pending exists, auto-send is on, and nothing sending', () => {
        const d = computeHealthCheckDecisions({
            hasAnswerWatcher: true,
            autoSendEnabled: true,
            pendingCount: 2,
            sendingCount: 0,
            answerDirectoryExists: true,
        });
        assert.equal(d.shouldTriggerSendNext, true);
    });

    test('requests watcher restart when watcher missing', () => {
        const d = computeHealthCheckDecisions({
            hasAnswerWatcher: false,
            autoSendEnabled: false,
            pendingCount: 0,
            sendingCount: 0,
            answerDirectoryExists: true,
        });
        assert.equal(d.shouldRestartWatcher, true);
    });

    test('requests directory recreation when answer directory missing', () => {
        const d = computeHealthCheckDecisions({
            hasAnswerWatcher: true,
            autoSendEnabled: false,
            pendingCount: 0,
            sendingCount: 0,
            answerDirectoryExists: false,
        });
        assert.equal(d.shouldEnsureDirectory, true);
        assert.equal(d.shouldRestartWatcher, true);
    });

    test('requests watcher restart when sending item is stale beyond 2x timeout', () => {
        const nowMs = Date.now();
        const staleSentAt = new Date(nowMs - (121 * 60_000)).toISOString();
        const d = computeHealthCheckDecisions({
            hasAnswerWatcher: true,
            autoSendEnabled: false,
            pendingCount: 0,
            sendingCount: 1,
            answerDirectoryExists: true,
            sendingSentAtIso: staleSentAt,
            responseFileTimeoutMinutes: 60,
            nowMs,
        });
        assert.equal(d.shouldRestartWatcher, true);
    });
});

describe('qrfix2: which window takes an answer file (the folder is shared by every window)', () => {
    const own = windowAnswerFileStem('aaaaaaaa-1111', 'mmmmmmmm-2222');
    const foreign = windowAnswerFileStem('bbbbbbbb-3333', 'mmmmmmmm-2222');
    const copilot = (fileName: string, expectedRequestId?: string) => ({ fileName, stageTransport: 'copilot' as const, expectedRequestId, windowFileStem: own });

    test('the request\'s own file: owned, by its name alone', () => {
        assert.deepEqual(answerFileClaim(copilot('req-1_answer.json', 'req-1')), { claim: 'request' });
        assert.equal(ownsAnswerFile(copilot('req-1_answer.json', 'req-1'), undefined), true);
    });

    test('another request\'s file: not owned', () => {
        assert.equal(answerFileClaim(copilot('req-2_answer.json', 'req-1')).claim, 'none');
        assert.equal(ownsAnswerFile(copilot('req-2_answer.json', 'req-1'), 'req-1'), false);
    });

    test('this window\'s own window-named file: owned only when its content names the expected request', () => {
        assert.deepEqual(answerFileClaim(copilot(`${own}_answer.json`, 'req-1')), { claim: 'window' });
        assert.equal(ownsAnswerFile(copilot(`${own}_answer.json`, 'req-1'), 'req-1'), true);
        assert.equal(ownsAnswerFile(copilot(`${own}_answer.json`, 'req-1'), 'req-9'), false, 'content id mismatch');
        assert.equal(ownsAnswerFile(copilot(`${own}_answer.json`, 'req-1'), undefined), false, 'no content id');
    });

    test('another window\'s window-named file: never owned, whatever its content says', () => {
        assert.equal(answerFileClaim(copilot(`${foreign}_answer.json`, 'req-1')).claim, 'none');
        assert.equal(ownsAnswerFile(copilot(`${foreign}_answer.json`, 'req-1'), 'req-1'), false);
    });

    test('a stage that waits for no answer file takes none', () => {
        assert.equal(answerFileClaim(copilot(`${own}_answer.json`, undefined)).claim, 'none');
        assert.equal(answerFileClaim(copilot(`${foreign}_answer.json`, '')).claim, 'none');
        assert.equal(ownsAnswerFile(copilot('req-1_answer.json', undefined), 'req-1'), false);
    });

    test('an Anthropic stage takes none, even with a (stale) expected id', () => {
        const input = { fileName: 'req-1_answer.json', stageTransport: 'anthropic' as const, expectedRequestId: 'req-1', windowFileStem: own };
        assert.equal(answerFileClaim(input).claim, 'none');
        assert.equal(ownsAnswerFile(input, 'req-1'), false);
        assert.equal(answerFileClaim({ ...input, stageTransport: undefined }).claim, 'none');
    });

    test('a file that is no answer file is not claimed', () => {
        assert.equal(answerFileClaim(copilot('req-1.json', 'req-1')).claim, 'none');
    });
});
