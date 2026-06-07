/**
 * Guards that `@modelcontextprotocol/sdk` is a DIRECT dependency (plan §7, todo
 * #14). Until now it was only transitive (via `@anthropic-ai/claude-agent-sdk`),
 * so the standalone MCP server (#16) would import an undeclared package — a
 * latent break the moment the agent-sdk drops or bumps it. Promoting it to a
 * first-class dependency makes the resolution explicit and stable.
 *
 * Two assertions cover #14's "Done when: it resolves and imports cleanly":
 *   1. package.json `dependencies` lists `@modelcontextprotocol/sdk` (declared).
 *   2. The concrete `McpServer` class the #16 handler will build on imports
 *      cleanly under the extension's CommonJS Node16 build (resolves).
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Parse package.json (project root is three levels up from out/utils/__tests__). */
function readPackageJson(): { dependencies?: Record<string, string> } {
    return JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'));
}

describe('@modelcontextprotocol/sdk direct dependency (#14)', () => {
    test('is declared in package.json dependencies (not just transitive)', () => {
        const deps = readPackageJson().dependencies ?? {};
        assert.ok(
            typeof deps['@modelcontextprotocol/sdk'] === 'string'
                && deps['@modelcontextprotocol/sdk'].length > 0,
            'expected @modelcontextprotocol/sdk in package.json dependencies',
        );
    });

    test('McpServer resolves and imports cleanly', () => {
        assert.equal(typeof McpServer, 'function');
    });
});
