/**
 * Tests for `getMcpServerSettings` — the pure resolver that applies the MCP
 * server's documented defaults to a (possibly partial / absent) `mcpServer`
 * config block.
 *
 * The standalone MCP server is configured independently of the chat profiles
 * (plan §6). This resolver is the single place those defaults live, so the
 * Status-Page card (Phase 3) and the server handler (Phase 4) read one source
 * of truth: `basePort` 19920, `host` 0.0.0.0, unauth = read-only (writes off),
 * tools on by default. The bound port is runtime state and is NOT part of this
 * resolved shape.
 *
 * `vscode` is stubbed before importing sendToChatConfig (which requires it),
 * mirroring the apiKeyAuthHeader / scripting-tools-bridge test seam.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    getMcpServerSettings,
    MCP_SERVER_DEFAULT_HOST,
    MCP_SERVER_DEFAULT_BASE_PORT,
} from '../sendToChatConfig.js';
import type { SendToChatConfig } from '../sendToChatConfig.js';

const cfgWith = (mcpServer: unknown): SendToChatConfig =>
    ({ mcpServer } as unknown as SendToChatConfig);

describe('getMcpServerSettings — defaults', () => {
    const expectedDefaults = {
        enabled: false,
        host: MCP_SERVER_DEFAULT_HOST,
        basePort: MCP_SERVER_DEFAULT_BASE_PORT,
        apiKeyEnv: '',
        allowWriteWithoutAuth: false,
        toolsEnabled: true,
        enabledTools: [],
    };

    test('the default base port is 19920 and host is 0.0.0.0', () => {
        assert.equal(MCP_SERVER_DEFAULT_BASE_PORT, 19920);
        assert.equal(MCP_SERVER_DEFAULT_HOST, '0.0.0.0');
    });

    test('null config → all defaults', () => {
        assert.deepEqual(getMcpServerSettings(null), expectedDefaults);
    });

    test('undefined config → all defaults', () => {
        assert.deepEqual(getMcpServerSettings(undefined), expectedDefaults);
    });

    test('missing mcpServer block → all defaults', () => {
        assert.deepEqual(getMcpServerSettings({} as SendToChatConfig), expectedDefaults);
    });

    test('empty mcpServer block → all defaults', () => {
        assert.deepEqual(getMcpServerSettings(cfgWith({})), expectedDefaults);
    });
});

describe('getMcpServerSettings — overrides honoured', () => {
    test('every field is taken from config when present', () => {
        const settings = getMcpServerSettings(cfgWith({
            enabled: true,
            host: '127.0.0.1',
            basePort: 20000,
            apiKeyEnv: 'MCP_KEY',
            allowWriteWithoutAuth: true,
            toolsEnabled: false,
            enabledTools: ['tomAi_readFile'],
        }));
        assert.deepEqual(settings, {
            enabled: true,
            host: '127.0.0.1',
            basePort: 20000,
            apiKeyEnv: 'MCP_KEY',
            allowWriteWithoutAuth: true,
            toolsEnabled: false,
            enabledTools: ['tomAi_readFile'],
        });
    });
});

describe('getMcpServerSettings — sane fallbacks for bad values', () => {
    test('blank / whitespace host falls back to the default', () => {
        assert.equal(getMcpServerSettings(cfgWith({ host: '' })).host, MCP_SERVER_DEFAULT_HOST);
        assert.equal(getMcpServerSettings(cfgWith({ host: '   ' })).host, MCP_SERVER_DEFAULT_HOST);
    });

    test('non-positive / non-number basePort falls back to 19920', () => {
        assert.equal(getMcpServerSettings(cfgWith({ basePort: 0 })).basePort, MCP_SERVER_DEFAULT_BASE_PORT);
        assert.equal(getMcpServerSettings(cfgWith({ basePort: -5 })).basePort, MCP_SERVER_DEFAULT_BASE_PORT);
        assert.equal(
            getMcpServerSettings(cfgWith({ basePort: 'nope' })).basePort,
            MCP_SERVER_DEFAULT_BASE_PORT,
        );
    });

    test('apiKeyEnv is trimmed', () => {
        assert.equal(getMcpServerSettings(cfgWith({ apiKeyEnv: '  MCP_KEY  ' })).apiKeyEnv, 'MCP_KEY');
    });

    test('toolsEnabled defaults to true and is false only when explicitly false', () => {
        assert.equal(getMcpServerSettings(cfgWith({})).toolsEnabled, true);
        assert.equal(getMcpServerSettings(cfgWith({ toolsEnabled: false })).toolsEnabled, false);
        assert.equal(getMcpServerSettings(cfgWith({ toolsEnabled: true })).toolsEnabled, true);
    });

    test('non-array enabledTools falls back to an empty list', () => {
        assert.deepEqual(getMcpServerSettings(cfgWith({ enabledTools: 'oops' })).enabledTools, []);
    });
});
