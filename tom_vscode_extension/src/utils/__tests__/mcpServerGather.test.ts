/**
 * Tests for the MCP Server card's save gather-map (plan §6, todo #11).
 *
 * `buildMcpServerConfigFromMessage` is the pure server-side "gather map": it
 * turns the field payload the Status-Page webview posts (raw, possibly
 * string-typed values from inputs) into the on-disk `McpServerConfig` shape.
 * The save handler in statusPage-handler.ts is a thin wrapper that assigns the
 * result to `config.mcpServer` and calls `saveSendToChatConfig` — so pinning
 * the gather map plus the resolve round-trip here proves the todo's "Done
 * when: edits round-trip to disk" without driving the 3000-line handler or a
 * real file write.
 *
 * The coercion is a pure function (no `vscode`), but the round-trip assertions
 * read the values back through `getMcpServerSettings`, which lives in
 * sendToChatConfig (requires `vscode`) — so the stub is installed first,
 * mirroring the mcpServerSchema / apiKeyAuthHeader test seam.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { buildMcpServerConfigFromMessage } from '../mcpServerCard.js';
import { getMcpServerSettings, MCP_SERVER_DEFAULT_HOST, MCP_SERVER_DEFAULT_BASE_PORT } from '../sendToChatConfig.js';

describe('buildMcpServerConfigFromMessage — type coercion', () => {
    test('coerces the explicit field payload into the on-disk shape', () => {
        const built = buildMcpServerConfigFromMessage({
            enabled: true,
            autoStart: true,
            host: '  10.8.0.7  ',
            basePort: '20000', // webview number inputs arrive as strings
            apiKeyEnv: '  MCP_KEY  ',
            allowWriteWithoutAuth: true,
            toolsEnabled: false,
            enabledTools: ['tomAi_readFile', 'tomAi_applyEdit'],
        });
        assert.equal(built.enabled, true);
        assert.equal(built.autoStart, true);
        assert.equal(built.host, '10.8.0.7'); // trimmed
        assert.equal(built.basePort, 20000); // string → number
        assert.equal(built.apiKeyEnv, 'MCP_KEY'); // trimmed
        assert.equal(built.allowWriteWithoutAuth, true);
        assert.equal(built.toolsEnabled, false);
        assert.deepEqual(built.enabledTools, ['tomAi_readFile', 'tomAi_applyEdit']);
    });

    test('booleans default to safe values when fields are missing/non-boolean', () => {
        const built = buildMcpServerConfigFromMessage({});
        assert.equal(built.enabled, false);
        assert.equal(built.autoStart, false);
        assert.equal(built.allowWriteWithoutAuth, false);
        // toolsEnabled is "all tools" unless explicitly false
        assert.equal(built.toolsEnabled, true);
        assert.deepEqual(built.enabledTools, []);
    });

    test('blank host / invalid basePort are dropped so the resolver supplies defaults', () => {
        const built = buildMcpServerConfigFromMessage({ host: '   ', basePort: 'not-a-number' });
        assert.equal(built.host, undefined);
        assert.equal(built.basePort, undefined);
    });

    test('non-positive basePort is rejected (dropped)', () => {
        assert.equal(buildMcpServerConfigFromMessage({ basePort: 0 }).basePort, undefined);
        assert.equal(buildMcpServerConfigFromMessage({ basePort: -5 }).basePort, undefined);
    });

    test('enabledTools keeps only string entries', () => {
        const built = buildMcpServerConfigFromMessage({
            enabledTools: ['tomAi_readFile', 42, null, 'tomAi_applyEdit'] as unknown[],
        });
        assert.deepEqual(built.enabledTools, ['tomAi_readFile', 'tomAi_applyEdit']);
    });

    test('blank apiKeyEnv is dropped (unauthenticated)', () => {
        assert.equal(buildMcpServerConfigFromMessage({ apiKeyEnv: '   ' }).apiKeyEnv, undefined);
    });
});

describe('gather map → resolver round-trip (edits round-trip to disk)', () => {
    test('a full edit round-trips to the same resolved settings', () => {
        const built = buildMcpServerConfigFromMessage({
            enabled: true,
            autoStart: true,
            host: '10.8.0.7',
            basePort: 20000,
            apiKeyEnv: 'MCP_KEY',
            allowWriteWithoutAuth: true,
            toolsEnabled: false,
            enabledTools: ['tomAi_readFile'],
        });
        // Simulate the disk hop: saveSendToChatConfig writes JSON, load + resolve
        // reads it back. JSON.parse/stringify models the on-disk serialisation.
        const onDisk = JSON.parse(JSON.stringify({ mcpServer: built }));
        const resolved = getMcpServerSettings(onDisk);
        assert.deepEqual(resolved, {
            enabled: true,
            autoStart: true,
            host: '10.8.0.7',
            basePort: 20000,
            apiKeyEnv: 'MCP_KEY',
            allowWriteWithoutAuth: true,
            toolsEnabled: false,
            enabledTools: ['tomAi_readFile'],
        });
    });

    test('cleared fields round-trip to the documented defaults', () => {
        const built = buildMcpServerConfigFromMessage({
            enabled: false,
            host: '',
            basePort: '',
            apiKeyEnv: '',
            toolsEnabled: true,
        });
        const resolved = getMcpServerSettings(JSON.parse(JSON.stringify({ mcpServer: built })));
        assert.equal(resolved.host, MCP_SERVER_DEFAULT_HOST);
        assert.equal(resolved.basePort, MCP_SERVER_DEFAULT_BASE_PORT);
        assert.equal(resolved.apiKeyEnv, '');
        assert.equal(resolved.enabled, false);
        assert.equal(resolved.toolsEnabled, true);
    });
});
