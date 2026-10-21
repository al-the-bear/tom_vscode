/**
 * Where a queue send goes, as the 'Tom Prompt Queue' log names it (vbs5).
 * Every send used to be logged "to Copilot", the Anthropic ones too, so
 * reading the log to find out where a prompt went was misleading.
 *
 *   QT-1 a Copilot send names the transport and nothing else
 *   QT-2 an Anthropic send names the profile (or that the default profile is used), the configuration when one
 *        is set explicitly, and the session when the item runs in one
 *   QT-3 the manager's send and resume lines use it, resolved as the dispatcher resolves the main stage; no
 *        queue log line says "to Copilot" any more
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import * as fs from 'fs';
import * as path from 'path';

import { describeQueueSendTarget } from '../queueSendTarget.js';

describe('describeQueueSendTarget', () => {
    test('QT-1: Copilot', () => {
        assert.equal(describeQueueSendTarget({ transport: 'copilot' }), 'via copilot');
        assert.equal(describeQueueSendTarget({ transport: 'copilot', anthropicProfileId: 'ignored', session: 'ignored' }), 'via copilot');
    });

    test('QT-2: Anthropic', () => {
        assert.equal(describeQueueSendTarget({ transport: 'anthropic', anthropicProfileId: 'sonnet-4-6-direct', session: 'vsd4-prep' }),
            'via anthropic (profile sonnet-4-6-direct, session vsd4-prep)');
        assert.equal(describeQueueSendTarget({ transport: 'anthropic' }), 'via anthropic (default profile)');
        assert.equal(describeQueueSendTarget({ transport: 'anthropic', anthropicProfileId: 'p', anthropicConfigId: 'c' }),
            'via anthropic (profile p, configuration c)');
        assert.equal(describeQueueSendTarget({ transport: 'anthropic', anthropicProfileId: 'p', anthropicConfigId: '  ', session: '' }),
            'via anthropic (profile p)', 'a blank configuration or session is none');
    });

    test('QT-3: the manager logs the real target', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'managers', 'promptQueueManager.ts'), 'utf8');
        assert.match(src, /const target = describeQueueSendTarget\(this\.resolveStageTransport\(item\)\);/);
        assert.match(src, /logQueue\(`Sending prompt \$\{item\.id\} \$\{target\} — /);
        assert.match(src, /logQueue\(`Resuming prompt \$\{item\.id\} \$\{target\} from prior progress/);
        assert.doesNotMatch(src, /logQueue\([^\n]*to Copilot/);
    });
});
