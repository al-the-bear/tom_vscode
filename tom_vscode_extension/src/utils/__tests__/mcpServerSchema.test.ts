/**
 * Lockstep tests for the `mcpServer` config block: the JSON Schema in
 * `src/config/tom_vscode_extension.schema.json` must agree field-for-field with
 * the `McpServerConfig` TypeScript type in `src/utils/sendToChatConfig.ts`
 * (plan §6, todo #9). The schema and the type are two declarations of one
 * shape; this test is the guard that they cannot drift apart.
 *
 * TypeScript interfaces don't exist at runtime, so "field-for-field" is pinned
 * here as an explicit spec table (the single source of truth derived from the
 * interface). The test asserts the schema (the built copy in `out/config/`,
 * refreshed by `npm run compile` before tests) carries exactly those fields,
 * types, and defaults — and that the schema defaults match the values
 * `getMcpServerSettings` resolves for an empty config, so the two never disagree
 * on what "default" means.
 *
 * `vscode` is stubbed before importing sendToChatConfig (which requires it),
 * mirroring the mcpServerSettings / apiKeyAuthHeader test seam.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    getMcpServerSettings,
    MCP_SERVER_DEFAULT_HOST,
    MCP_SERVER_DEFAULT_BASE_PORT,
} from '../sendToChatConfig.js';

/**
 * The spec table — one row per `McpServerConfig` field. `jsonType` is the JSON
 * Schema `type`; `def` is the expected schema `default`. Kept in lockstep with
 * the interface by hand (interfaces are erased at runtime).
 */
const EXPECTED_FIELDS: Record<string, { jsonType: string; def: unknown }> = {
    enabled: { jsonType: 'boolean', def: false },
    host: { jsonType: 'string', def: MCP_SERVER_DEFAULT_HOST },
    basePort: { jsonType: 'integer', def: MCP_SERVER_DEFAULT_BASE_PORT },
    apiKeyEnv: { jsonType: 'string', def: '' },
    allowWriteWithoutAuth: { jsonType: 'boolean', def: false },
    toolsEnabled: { jsonType: 'boolean', def: true },
    enabledTools: { jsonType: 'array', def: [] },
};

/** Load the built schema (kept fresh by the `pretest` compile step). */
function loadSchema(): Record<string, unknown> {
    const schemaPath = join(__dirname, '..', '..', 'config', 'tom_vscode_extension.schema.json');
    return JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
}

function mcpServerSchema(): Record<string, unknown> {
    const schema = loadSchema();
    const props = schema.properties as Record<string, unknown> | undefined;
    const mcp = props?.mcpServer as Record<string, unknown> | undefined;
    assert.ok(mcp, 'schema is missing the top-level `mcpServer` property');
    return mcp;
}

describe('mcpServer schema — shape', () => {
    test('mcpServer is an object schema with closed additionalProperties', () => {
        const mcp = mcpServerSchema();
        assert.equal(mcp.type, 'object');
        assert.equal(
            mcp.additionalProperties,
            false,
            'mcpServer must close additionalProperties so config typos are caught',
        );
    });

    test('the schema declares exactly the McpServerConfig fields — no more, no less', () => {
        const props = mcpServerSchema().properties as Record<string, unknown>;
        assert.deepEqual(
            Object.keys(props).sort(),
            Object.keys(EXPECTED_FIELDS).sort(),
            'schema fields drifted from McpServerConfig',
        );
    });
});

describe('mcpServer schema — field types and defaults', () => {
    for (const [field, { jsonType, def }] of Object.entries(EXPECTED_FIELDS)) {
        test(`${field}: type ${jsonType}, default ${JSON.stringify(def)}`, () => {
            const props = mcpServerSchema().properties as Record<string, Record<string, unknown>>;
            const prop = props[field];
            assert.ok(prop, `schema is missing field ${field}`);
            assert.equal(prop.type, jsonType, `${field} has the wrong JSON type`);
            assert.deepEqual(prop.default, def, `${field} has the wrong default`);
        });
    }

    test('enabledTools is an array of strings', () => {
        const props = mcpServerSchema().properties as Record<string, Record<string, unknown>>;
        const items = props.enabledTools.items as Record<string, unknown>;
        assert.equal(items.type, 'string');
    });
});

describe('mcpServer schema — defaults agree with the resolver', () => {
    test('schema defaults equal getMcpServerSettings(null)', () => {
        const props = mcpServerSchema().properties as Record<string, Record<string, unknown>>;
        const resolved = getMcpServerSettings(null) as unknown as Record<string, unknown>;
        for (const field of Object.keys(EXPECTED_FIELDS)) {
            assert.deepEqual(
                props[field].default,
                resolved[field],
                `${field}: schema default and resolver default disagree`,
            );
        }
    });
});
