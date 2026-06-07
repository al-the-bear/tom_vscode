/**
 * Tests for the "Tom AI: MCP Server" output channel (plan §7, todo #4).
 *
 * Mirrors `toolLog.ts`: a single channel created lazily and shared behind an
 * accessor so the Output dropdown shows ONE channel (a second
 * `createOutputChannel` of the same name would produce a confusing duplicate),
 * plus a thin `mcpLog` that prefixes each line with an ISO timestamp. The
 * channel is `vscode`-bound, so the module is exercised under the shared stub —
 * a custom `createOutputChannel` override records creations and appended lines.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const created: string[] = [];
const appended: string[] = [];

installVscodeStub({
    methodOverrides: {
        createOutputChannel: (name: string) => {
            created.push(name);
            return {
                name,
                append(): void { /* no-op */ },
                appendLine(line: string): void { appended.push(line); },
                clear(): void { /* no-op */ },
                show(): void { /* no-op */ },
                hide(): void { /* no-op */ },
                dispose(): void { /* no-op */ },
            };
        },
    },
});

// Static import AFTER the stub install (TS keeps statement order in CommonJS
// emit, so the `require('vscode')` inside mcpServerLog resolves to the stub).
import { MCP_LOG_CHANNEL_NAME, getMcpLogChannel, disposeMcpLogChannel, mcpLog } from '../mcpServerLog.js';

describe('mcpServerLog — shared MCP Server output channel', () => {
    test('creates a single channel lazily and reuses it (no duplicate)', () => {
        disposeMcpLogChannel();
        created.length = 0;

        const first = getMcpLogChannel();
        const second = getMcpLogChannel();

        assert.equal(created.length, 1);
        assert.equal(created[0], MCP_LOG_CHANNEL_NAME);
        assert.equal(MCP_LOG_CHANNEL_NAME, 'Tom AI: MCP Server');
        assert.equal(first, second);
    });

    test('mcpLog appends a line prefixed with an ISO timestamp', () => {
        appended.length = 0;

        mcpLog('server started');

        assert.equal(appended.length, 1);
        assert.match(appended[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z server started$/);
    });

    test('disposeMcpLogChannel is safe to call repeatedly', () => {
        getMcpLogChannel();
        disposeMcpLogChannel();
        disposeMcpLogChannel(); // no throw on the second call
        assert.ok(true);
    });
});
