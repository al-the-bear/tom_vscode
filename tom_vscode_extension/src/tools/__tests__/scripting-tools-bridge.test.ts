/**
 * Tests for the scripting-API tool surface.
 *
 * Covers the two rules the feature promises:
 *   1. The generated tools JSON reflects the active Anthropic profile's tool
 *      settings (toolsEnabled / enabledTools) — exercised through the pure
 *      `resolveProfileTools` + `toAnthropicTools` composition that
 *      `getActiveProfileToolsJson` performs after its config read.
 *   2. The Send-to-Chat target gate: 'copilot' → empty JSON, anything else
 *      → 'anthropic' (verified via `getSendToChatTarget`).
 *
 * Plus the universal-invoke contract: an unknown tool name surfaces the
 * registry's error string rather than throwing across the bridge.
 *
 * Run from the extension folder with:
 *   npm run compile && node --test out/tools/__tests__/scripting-tools-bridge.test.js
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

// Install the shared vscode stub BEFORE importing modules that require vscode.
import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import type * as vscode from 'vscode';
import { ALL_SHARED_TOOLS, resolveProfileTools } from '../tool-executors.js';
import { toAnthropicTools } from '../shared-tool-registry.js';
import type { SharedToolDefinition } from '../shared-tool-registry.js';
import { getSendToChatTarget } from '../../utils/sendToChatConfig.js';
import type { SendToChatConfig } from '../../utils/sendToChatConfig.js';
import {
    invokeToolByName,
    invokeAllowedTool,
    activeProfileToolNames,
    resolveActiveProfileToolNames,
} from '../scripting-tools-bridge.js';

describe('resolveProfileTools — active profile drives the tool set', () => {
    test('undefined profile → all tools', () => {
        assert.equal(resolveProfileTools(undefined).length, ALL_SHARED_TOOLS.length);
    });

    test('toolsEnabled !== false → all tools', () => {
        assert.equal(resolveProfileTools({ toolsEnabled: true }).length, ALL_SHARED_TOOLS.length);
        // Missing flag defaults to enabled.
        assert.equal(resolveProfileTools({}).length, ALL_SHARED_TOOLS.length);
    });

    test('toolsEnabled === false with empty allow-list → no tools', () => {
        assert.deepEqual(resolveProfileTools({ toolsEnabled: false, enabledTools: [] }), []);
        // Missing allow-list is treated as empty.
        assert.deepEqual(resolveProfileTools({ toolsEnabled: false }), []);
    });

    test('toolsEnabled === false with allow-list → only those tools', () => {
        const pick = ALL_SHARED_TOOLS[0].name;
        const tools = resolveProfileTools({ toolsEnabled: false, enabledTools: [pick, '__nope__'] });
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, pick);
    });
});

describe('toAnthropicTools — JSON shape injected into the prompt', () => {
    test('emits {name, description, input_schema}', () => {
        const pick = ALL_SHARED_TOOLS[0].name;
        const json = toAnthropicTools(resolveProfileTools({ toolsEnabled: false, enabledTools: [pick] }));
        assert.equal(json.length, 1);
        const entry = json[0];
        assert.equal(entry.name, pick);
        assert.equal(typeof entry.description, 'string');
        assert.equal(typeof entry.input_schema, 'object');
        // Anthropic wire key is `input_schema`, never `inputSchema`.
        assert.ok(!('inputSchema' in entry));
    });
});

describe('getSendToChatTarget — copilot gate / default', () => {
    test('defaults to anthropic', () => {
        assert.equal(getSendToChatTarget(null), 'anthropic');
        assert.equal(getSendToChatTarget(undefined), 'anthropic');
        assert.equal(getSendToChatTarget({} as never), 'anthropic');
    });

    test('honours explicit values; unknown falls back to anthropic', () => {
        assert.equal(getSendToChatTarget({ sendToChatTarget: 'copilot' } as never), 'copilot');
        assert.equal(getSendToChatTarget({ sendToChatTarget: 'anthropic' } as never), 'anthropic');
        assert.equal(getSendToChatTarget({ sendToChatTarget: 'bogus' } as never), 'anthropic');
    });
});

describe('activeProfileToolNames — single source for list + gate', () => {
    const cfgWith = (
        profiles: unknown[],
        target?: 'anthropic' | 'copilot',
    ): SendToChatConfig =>
        ({ sendToChatTarget: target, anthropic: { profiles } } as unknown as SendToChatConfig);

    // The four cases todo #3 enumerates for the active-profile resolution.

    test('copilot target → empty set regardless of profiles', () => {
        const names = activeProfileToolNames(
            cfgWith([{ id: 'p1', toolsEnabled: true }], 'copilot'),
            'p1',
        );
        assert.equal(names.size, 0);
    });

    test('toolsEnabled → all tool names', () => {
        const explicit = activeProfileToolNames(
            cfgWith([{ id: 'p1', toolsEnabled: true }]),
            'p1',
        );
        assert.equal(explicit.size, ALL_SHARED_TOOLS.length);
        // Missing flag defaults to enabled → all tools.
        const implied = activeProfileToolNames(cfgWith([{ id: 'p1' }]), 'p1');
        assert.equal(implied.size, ALL_SHARED_TOOLS.length);
    });

    test('enabledTools allow-list → subset', () => {
        const pick = ALL_SHARED_TOOLS[0].name;
        const names = activeProfileToolNames(
            cfgWith([{ id: 'p1', toolsEnabled: false, enabledTools: [pick, '__nope__'] }]),
            'p1',
        );
        assert.deepEqual([...names], [pick]);
    });

    test('empty allow-list (or missing) → empty set', () => {
        const emptyList = activeProfileToolNames(
            cfgWith([{ id: 'p1', toolsEnabled: false, enabledTools: [] }]),
            'p1',
        );
        assert.equal(emptyList.size, 0);
        // Missing allow-list is treated as empty.
        const missingList = activeProfileToolNames(
            cfgWith([{ id: 'p1', toolsEnabled: false }]),
            'p1',
        );
        assert.equal(missingList.size, 0);
    });

    test('no profiles → all tools (undefined profile)', () => {
        const names = activeProfileToolNames(cfgWith([]), '');
        assert.equal(names.size, ALL_SHARED_TOOLS.length);
    });

    test('active id selects the matching profile allow-list', () => {
        const pick = ALL_SHARED_TOOLS[0].name;
        const names = activeProfileToolNames(
            cfgWith([
                { id: 'all', toolsEnabled: true },
                { id: 'subset', toolsEnabled: false, enabledTools: [pick] },
            ]),
            'subset',
        );
        assert.deepEqual([...names], [pick]);
    });

    test('unmatched active id falls back to isDefault, then first', () => {
        const pick = ALL_SHARED_TOOLS[0].name;
        const byDefault = activeProfileToolNames(
            cfgWith([
                { id: 'first', toolsEnabled: true },
                { id: 'def', isDefault: true, toolsEnabled: false, enabledTools: [pick] },
            ]),
            'missing',
        );
        assert.deepEqual([...byDefault], [pick]);

        const byFirst = activeProfileToolNames(
            cfgWith([
                { id: 'first', toolsEnabled: false, enabledTools: [pick] },
                { id: 'second', toolsEnabled: true },
            ]),
            'missing',
        );
        assert.deepEqual([...byFirst], [pick]);
    });
});

describe('resolveActiveProfileToolNames — context wrapper delegates to the resolver', () => {
    // The context-bound wrapper reads the live config + the workspaceState
    // active-profile id, then defers to activeProfileToolNames. With no config
    // file in the test env the resolver sees no profiles → all tools, proving
    // the wrapper plumbs the injected context through without its own filtering.
    const fakeContext = {
        workspaceState: { get: <T>(_k: string, d?: T): T => d as T },
    } as unknown as vscode.ExtensionContext;

    test('no config on disk → all tool names', () => {
        const names = resolveActiveProfileToolNames(fakeContext);
        assert.equal(names.size, ALL_SHARED_TOOLS.length);
    });
});

describe('getActiveProfileToolsJson — listing behaviour unchanged by the refactor', () => {
    // The refactor builds the JSON from the same name set resolveProfileTools
    // produces, so filtering ALL_SHARED_TOOLS by that set must yield the exact
    // same Anthropic JSON (same entries, same order) as the old composition.
    const sameAsOld = (
        profile: { toolsEnabled?: boolean; enabledTools?: string[] } | undefined,
    ): void => {
        const allowed = new Set(resolveProfileTools(profile).map((t) => t.name));
        const viaNames = toAnthropicTools(ALL_SHARED_TOOLS.filter((t) => allowed.has(t.name)));
        const viaOld = toAnthropicTools(resolveProfileTools(profile));
        assert.deepEqual(viaNames, viaOld);
    };

    test('all-tools profile', () => sameAsOld({ toolsEnabled: true }));
    test('undefined profile', () => sameAsOld(undefined));
    test('empty allow-list profile', () => sameAsOld({ toolsEnabled: false, enabledTools: [] }));
    test('subset allow-list profile', () =>
        sameAsOld({
            toolsEnabled: false,
            enabledTools: [ALL_SHARED_TOOLS[0].name, ALL_SHARED_TOOLS[1].name],
        }));
});

describe('invokeAllowedTool — gate runs before the executor', () => {
    const spyTool = (
        name: string,
        onExecute: () => void,
        result = 'ok',
    ): SharedToolDefinition => ({
        name,
        displayName: name,
        description: name,
        inputSchema: { type: 'object', properties: {} },
        tags: [],
        readOnly: true,
        execute: async (): Promise<string> => {
            onExecute();
            return result;
        },
    });

    test('disallowed name → error string, executor never called', async () => {
        let called = false;
        const registry = [spyTool('allowed_tool', () => { called = true; })];
        const result = await invokeAllowedTool(
            new Set(['allowed_tool']),
            registry,
            'forbidden_tool',
            {},
        );
        assert.match(result, /not permitted by the active Anthropic profile/);
        assert.equal(called, false);
    });

    test('allowed name → executor runs, returns its result', async () => {
        let called = false;
        const registry = [spyTool('allowed_tool', () => { called = true; }, 'TOOL-RESULT')];
        const result = await invokeAllowedTool(
            new Set(['allowed_tool']),
            registry,
            'allowed_tool',
            {},
        );
        assert.equal(called, true);
        assert.equal(result, 'TOOL-RESULT');
    });

    test('allowed but absent from registry → executor reports the unknown tool', async () => {
        const result = await invokeAllowedTool(
            new Set(['__no_such_tool__']),
            [],
            '__no_such_tool__',
            {},
        );
        assert.equal(result, 'Error: unknown tool "__no_such_tool__"');
    });
});

describe('invokeToolByName — context-gated invoke', () => {
    // No config file in the test env → all tools allowed; an unknown name is
    // therefore refused by the gate before it can reach the executor.
    const fakeContext = {
        workspaceState: { get: <T>(_k: string, d?: T): T => d as T },
    } as unknown as vscode.ExtensionContext;

    test('a name absent from the registry is refused by the gate (no throw)', async () => {
        const result = await invokeToolByName(fakeContext, '__no_such_tool__', {});
        assert.match(result, /not permitted by the active Anthropic profile/);
    });
});
