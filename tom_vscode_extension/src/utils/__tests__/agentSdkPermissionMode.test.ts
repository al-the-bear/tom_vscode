/**
 * The profile's Tool Approval wins over its configuration's Agent SDK
 * permission mode (src/utils/agentSdkPermissionMode.ts).
 *
 * The SDK calls `canUseTool` — where the extension asks for approval — in every
 * permission mode but `bypassPermissions`. A profile set to Tool Approval
 * "Always" on a configuration in `bypassPermissions` therefore never asked:
 * vsc5's spec write ran on opus-5-5-agent-sdk-mm without an approval request.
 * The user's decision: for Anthropic the profile setting wins, and the profile
 * editor says the configuration's setting is ignored.
 *
 *   PM-1 "Never" runs in bypassPermissions whatever the configuration says
 *   PM-2 "Always" never runs in bypassPermissions: a configured bypass becomes `default`; the other
 *        configured modes (default, acceptEdits, plan) are kept, as is the SDK default when none is set
 *   PM-3 the override is reported (the transport logs it, the profile editor shows it) only when it happens
 *   PM-4 the transport takes its mode from this rule; the profile editor's Tool Approval help says the
 *        configuration's permission setting does not decide approval and names a bypassing configuration
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { effectivePermissionMode, permissionModeOverride } from '../agentSdkPermissionMode';

describe('Agent SDK permission mode', () => {
    test('PM-1: Never bypasses', () => {
        for (const configured of [undefined, 'default', 'acceptEdits', 'plan', 'bypassPermissions'] as const) {
            assert.equal(effectivePermissionMode('never', configured), 'bypassPermissions');
        }
    });

    test('PM-2: Always never bypasses', () => {
        assert.equal(effectivePermissionMode('always', 'bypassPermissions'), 'default');
        assert.equal(effectivePermissionMode('always', 'acceptEdits'), 'acceptEdits');
        assert.equal(effectivePermissionMode('always', 'plan'), 'plan');
        assert.equal(effectivePermissionMode('always', 'default'), 'default');
        assert.equal(effectivePermissionMode('always', undefined), 'default');
    });

    test('PM-3: the override is reported only when it happens', () => {
        assert.match(permissionModeOverride('always', 'bypassPermissions') ?? '', /bypassPermissions.*ignored/);
        assert.equal(permissionModeOverride('always', 'default'), undefined);
        assert.equal(permissionModeOverride('always', undefined), undefined);
        assert.equal(permissionModeOverride('never', 'bypassPermissions'), undefined);
    });

    test('PM-4: the transport and the profile editor follow the rule', () => {
        const src = (rel: string) => readFileSync(join(__dirname, '..', '..', '..', 'src', rel), 'utf-8');
        const transport = src('handlers/agent-sdk-transport.ts');
        assert.match(transport, /effectivePermissionMode\(approvalMode, configuredMode\)/);
        assert.doesNotMatch(transport, /approvalMode === 'never'\s*\?\s*'bypassPermissions'\s*:\s*configuredMode/,
            'the old rule let a configured bypass decide over Always');
        const editor = src('handlers/globalTemplateEditor-handler.ts');
        assert.match(editor, /toolApprovalHelp\(/);
        assert.match(editor, /permission mode does not decide approval/);
    });
});
