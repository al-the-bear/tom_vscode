/**
 * Tests for the MCP Server status-page card (plan §6, todo #10).
 *
 * The card render is a pure function so it is unit-testable without the
 * 3000-line statusPage handler or `vscode`: `buildMcpServerCardModel` maps
 * resolved `mcpServer` settings + runtime state into a view-model, and
 * `renderMcpServerCard` turns that view-model + the tool-name options into an
 * HTML fragment. These tests pin the "Done when" of #10: the card renders with
 * every control bound to `mcpServer` config and the status line reflects the
 * actual bound port when running.
 *
 * No `vscode` stub is needed — mcpServerCard imports only a TYPE from
 * sendToChatConfig (erased at runtime).
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildMcpServerCardModel,
    renderMcpServerCard,
    type McpServerCardModel,
} from '../mcpServerCard.js';

const baseSettings = {
    enabled: true,
    autoStart: false,
    host: '0.0.0.0',
    basePort: 19920,
    apiKeyEnv: 'MCP_KEY',
    allowWriteWithoutAuth: false,
    toolsEnabled: true,
    enabledTools: ['tomAi_readFile'],
};

describe('buildMcpServerCardModel', () => {
    test('stopped runtime → running false, no bound host/port', () => {
        const model = buildMcpServerCardModel(baseSettings, { running: false });
        assert.equal(model.running, false);
        assert.equal(model.boundHost, undefined);
        assert.equal(model.boundPort, undefined);
        // settings carry through
        assert.equal(model.enabled, true);
        assert.equal(model.host, '0.0.0.0');
        assert.equal(model.basePort, 19920);
        assert.equal(model.apiKeyEnv, 'MCP_KEY');
        assert.equal(model.toolsEnabled, true);
        assert.deepEqual(model.enabledTools, ['tomAi_readFile']);
    });

    test('running runtime → running true with the live bound host:port', () => {
        const model = buildMcpServerCardModel(baseSettings, {
            running: true,
            host: '10.8.0.7',
            port: 19923,
        });
        assert.equal(model.running, true);
        assert.equal(model.boundHost, '10.8.0.7');
        assert.equal(model.boundPort, 19923);
    });
});

describe('renderMcpServerCard — controls bound to mcpServer config', () => {
    const model: McpServerCardModel = buildMcpServerCardModel(baseSettings, { running: false });
    const html = renderMcpServerCard(model, ['tomAi_readFile', 'tomAi_applyEdit']);

    test('renders a single MCP server section card', () => {
        assert.match(html, /sp-section/);
        assert.match(html, /MCP Server/);
        assert.match(html, /data-mcp-card/);
    });

    test('host, basePort and apiKeyEnv inputs are bound with current values', () => {
        assert.match(html, /data-mcp-field="host"[^>]*value="0\.0\.0\.0"/);
        assert.match(html, /data-mcp-field="basePort"[^>]*value="19920"/);
        assert.match(html, /data-mcp-field="apiKeyEnv"[^>]*value="MCP_KEY"/);
    });

    test('enabled, autoStart and allowWriteWithoutAuth checkboxes are present and reflect state', () => {
        assert.match(html, /data-mcp-field="enabled"[^>]*checked/);
        // autoStart is false → present but not checked
        assert.match(html, /data-mcp-field="autoStart"/);
        assert.doesNotMatch(html, /data-mcp-field="autoStart"[^>]*checked/);
        assert.match(html, /data-mcp-field="allowWriteWithoutAuth"/);
    });

    test('toolsEnabled control is present', () => {
        assert.match(html, /data-mcp-field="toolsEnabled"/);
    });

    test('Start and Stop buttons route to the MCP lifecycle actions', () => {
        assert.match(html, /data-status-action="startMcpServer"/);
        assert.match(html, /data-status-action="stopMcpServer"/);
    });

    test('renders a tool checkbox per option, checked only for enabledTools', () => {
        assert.match(html, /data-mcp-tool="tomAi_readFile"[^>]*checked/);
        assert.match(html, /data-mcp-tool="tomAi_applyEdit"/);
        assert.doesNotMatch(html, /data-mcp-tool="tomAi_applyEdit"[^>]*checked/);
    });
});

describe('renderMcpServerCard — status line', () => {
    test('stopped → shows a Stopped badge, no host:port', () => {
        const html = renderMcpServerCard(
            buildMcpServerCardModel(baseSettings, { running: false }),
            [],
        );
        assert.match(html, /sp-stopped/);
        assert.match(html, /Stopped/);
    });

    test('running → status line shows the live bound host:port', () => {
        const html = renderMcpServerCard(
            buildMcpServerCardModel(baseSettings, { running: true, host: '10.8.0.7', port: 19923 }),
            [],
        );
        assert.match(html, /sp-running/);
        assert.match(html, /10\.8\.0\.7:19923/);
    });
});

describe('renderMcpServerCard — escaping', () => {
    test('host and apiKeyEnv values are attribute-escaped (no breakout)', () => {
        const evil = buildMcpServerCardModel(
            { ...baseSettings, host: '"><script>x', apiKeyEnv: 'A"B' },
            { running: false },
        );
        const html = renderMcpServerCard(evil, []);
        assert.doesNotMatch(html, /<script>x/);
        assert.match(html, /&quot;/);
    });
});
