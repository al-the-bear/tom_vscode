import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    sanitizeHostnameForFile,
    buildQueueEntryFileName,
    buildTimedFileName,
} from '../queueStep5Utils.js';

describe('Step 5 - Issue 1 queue/timed filename strategy', () => {
    test('sanitizeHostnameForFile lowercases and strips unsupported characters', () => {
        assert.equal(sanitizeHostnameForFile('My.Host Name!'), 'my_host_name_');
    });

    test('buildQueueEntryFileName prefixes hostname', () => {
        const stableLocalDate = new Date(2026, 2, 26, 14, 5, 6);
        const fileName = buildQueueEntryFileName({
            hostname: 'dev-box',
            timestamp: stableLocalDate,
            quest: 'vscode_extension',
            type: 'prompt',
            entrySuffix: '.entry.queue.yaml',
        });

        assert.equal(fileName, 'dev-box_260326_140506_vscode_extension.prompt.entry.queue.yaml');
    });

    test('buildTimedFileName returns host-prefixed timed filename', () => {
        const fileName = buildTimedFileName('dev-box', 'tom_agent_container');
        assert.equal(fileName, 'dev-box_tom_agent_container.timed.yaml');
    });
});
