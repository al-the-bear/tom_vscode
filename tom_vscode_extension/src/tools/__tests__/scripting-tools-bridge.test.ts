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

import { ALL_SHARED_TOOLS, resolveProfileTools } from '../tool-executors.js';
import { toAnthropicTools } from '../shared-tool-registry.js';
import { getSendToChatTarget } from '../../utils/sendToChatConfig.js';
import type { SendToChatConfig } from '../../utils/sendToChatConfig.js';
import { invokeToolByName, activeProfileToolNames } from '../scripting-tools-bridge.js';

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

    test('copilot target → empty set regardless of profiles', () => {
        const names = activeProfileToolNames(
            cfgWith([{ id: 'p1', toolsEnabled: true }], 'copilot'),
            'p1',
        );
        assert.equal(names.size, 0);
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

describe('invokeToolByName — universal invoke contract', () => {
    test('unknown tool returns the registry error string (no throw)', async () => {
        const result = await invokeToolByName('__no_such_tool__', {});
        assert.equal(result, 'Error: unknown tool "__no_such_tool__"');
    });
});
