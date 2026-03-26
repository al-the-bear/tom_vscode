import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    sanitizeHostnameForFile,
    buildQueueEntryFileName,
    buildTimedFileNames,
    pickTimedReadPath,
    shouldMigrateTimedFileOnWrite,
} from '../queueStep5Utils';

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

    test('buildTimedFileNames returns host-prefixed and legacy names', () => {
        const names = buildTimedFileNames('dev-box', 'tom_agent_container');
        assert.equal(names.nextFileName, 'dev-box_tom_agent_container.timed.yaml');
        assert.equal(names.legacyFileName, 'tom_agent_container.timed.yaml');
    });

    test('pickTimedReadPath prefers new file and falls back to legacy', () => {
        const preferred = pickTimedReadPath({
            nextPath: '/a/dev-box_ws.timed.yaml',
            legacyPath: '/a/ws.timed.yaml',
            nextExists: true,
            legacyExists: true,
        });
        assert.equal(preferred, '/a/dev-box_ws.timed.yaml');

        const fallback = pickTimedReadPath({
            nextPath: '/a/dev-box_ws.timed.yaml',
            legacyPath: '/a/ws.timed.yaml',
            nextExists: false,
            legacyExists: true,
        });
        assert.equal(fallback, '/a/ws.timed.yaml');
    });

    test('shouldMigrateTimedFileOnWrite migrates legacy only when new file missing', () => {
        assert.equal(
            shouldMigrateTimedFileOnWrite({ nextExists: false, legacyExists: true }),
            true,
        );
        assert.equal(
            shouldMigrateTimedFileOnWrite({ nextExists: true, legacyExists: true }),
            false,
        );
        assert.equal(
            shouldMigrateTimedFileOnWrite({ nextExists: false, legacyExists: false }),
            false,
        );
    });
});
