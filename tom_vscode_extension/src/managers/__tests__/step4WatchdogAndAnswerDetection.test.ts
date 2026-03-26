import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildAnswerFilePath,
    shouldWatchAnswerFile,
    extractRequestIdFromAnswerFilename,
    findMatchingAnswerFile,
    computeHealthCheckDecisions,
} from '../../utils/queueStep4Utils';

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
});
