/**
 * Tests for the shared "Tom Tool Log" output channel and, in particular, the
 * config-access de-duplication in `logConfigAccess`.
 *
 * `configPath` is read on a hot path (every `loadSendToChatConfig()`, which
 * several pollers call every few seconds), so without de-duplication the
 * unchanged "resolve" diagnostic spammed the log dozens of times a minute. The
 * helper must emit a given source's line once and again only when its content
 * changes. The channel is `vscode`-bound, so the module runs under the shared
 * stub with a `createOutputChannel` override that records appended lines.
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const appended: string[] = [];

installVscodeStub({
    methodOverrides: {
        createOutputChannel: (name: string) => ({
            name,
            append(): void { /* no-op */ },
            appendLine(line: string): void { appended.push(line); },
            clear(): void { /* no-op */ },
            show(): void { /* no-op */ },
            hide(): void { /* no-op */ },
            dispose(): void { /* no-op */ },
        }),
    },
});

// Static import AFTER the stub install (TS keeps statement order in the
// CommonJS emit, so `require('vscode')` inside toolLog resolves to the stub).
import { logConfigAccess, toolLog } from '../toolLog.js';

describe('logConfigAccess — config-access de-duplication', () => {
    beforeEach(() => {
        appended.length = 0;
    });

    test('emits an unchanged line from the same source only once', () => {
        const details = { action: 'resolve', branch: 'workspace .tom (exists)' };
        logConfigAccess('TomAiConfiguration.configPath', '/tmp/cfg.json', details);
        logConfigAccess('TomAiConfiguration.configPath', '/tmp/cfg.json', details);
        logConfigAccess('TomAiConfiguration.configPath', '/tmp/cfg.json', details);

        assert.equal(appended.length, 1);
        assert.match(appended[0], /from=TomAiConfiguration\.configPath/);
        assert.match(appended[0], /action=resolve/);
    });

    test('re-emits when the resolved path changes for the same source', () => {
        const details = { action: 'resolve', branch: 'workspace .tom (exists)' };
        logConfigAccess('TomAiConfiguration.configPath', '/tmp/a.json', details);
        logConfigAccess('TomAiConfiguration.configPath', '/tmp/a.json', details);
        logConfigAccess('TomAiConfiguration.configPath', '/tmp/b.json', details);

        assert.equal(appended.length, 2);
        assert.match(appended[0], /path=\/tmp\/a\.json/);
        assert.match(appended[1], /path=\/tmp\/b\.json/);
    });

    test('de-duplicates per source independently', () => {
        const details = { action: 'resolve' };
        logConfigAccess('sourceA', '/tmp/cfg.json', details);
        logConfigAccess('sourceB', '/tmp/cfg.json', details);
        // Repeats of each are suppressed.
        logConfigAccess('sourceA', '/tmp/cfg.json', details);
        logConfigAccess('sourceB', '/tmp/cfg.json', details);

        assert.equal(appended.length, 2);
        assert.match(appended[0], /from=sourceA/);
        assert.match(appended[1], /from=sourceB/);
    });
});

describe('toolLog', () => {
    test('appends a line prefixed with an ISO timestamp', () => {
        appended.length = 0;
        toolLog('hello');

        assert.equal(appended.length, 1);
        assert.match(appended[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z hello$/);
    });
});
