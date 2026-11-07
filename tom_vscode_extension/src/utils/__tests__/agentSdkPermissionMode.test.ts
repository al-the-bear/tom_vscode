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
 *   PM-5 Claude Code's built-ins (CC-2): the writers (Bash, Write, Edit, MultiEdit, NotebookEdit, KillShell) ask,
 *        the readers (Read, Grep, Glob, WebFetch, WebSearch, …) do not; a built-in this list does not know asks
 *   PM-6 with the built-ins on, "Always" also runs a configured acceptEdits or auto as `default` (both accept
 *        writes without calling canUseTool), and says so; without them those modes are kept
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { builtInToolNeedsApproval, effectivePermissionMode, permissionModeOverride } from '../agentSdkPermissionMode';

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
        assert.match(transport, /effectivePermissionMode\(approvalMode, configuredMode, builtInTools\)/);
        assert.match(transport, /builtInToolNeedsApproval\(bare\)/, 'the built-ins go through the approval (CC-2)');
        assert.doesNotMatch(transport, /approvalMode === 'never'\s*\?\s*'bypassPermissions'\s*:\s*configuredMode/,
            'the old rule let a configured bypass decide over Always');
        const editor = src('handlers/globalTemplateEditor-handler.ts');
        assert.match(editor, /toolApprovalHelp\(/);
        assert.match(editor, /permission mode does not decide approval/);
        assert.match(editor, /built-in tools on, its writers \(Bash, Write, Edit, MultiEdit, NotebookEdit, KillShell\) ask/);
    });

    test('PM-5: which built-ins ask', () => {
        for (const writer of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'KillShell', 'KillBash']) {
            assert.equal(builtInToolNeedsApproval(writer), true, writer);
        }
        for (const reader of ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'BashOutput', 'TodoWrite', 'Task', 'NotebookRead']) {
            assert.equal(builtInToolNeedsApproval(reader), false, reader);
        }
        assert.equal(builtInToolNeedsApproval('SomeFutureTool'), true, 'unknown: asks rather than writes unasked');
    });

    test('PM-6: built-ins on: no mode that accepts writes unasked', () => {
        assert.equal(effectivePermissionMode('always', 'acceptEdits', true), 'default');
        assert.equal(effectivePermissionMode('always', 'auto', true), 'default');
        assert.equal(effectivePermissionMode('always', 'bypassPermissions', true), 'default');
        assert.equal(effectivePermissionMode('always', 'plan', true), 'plan');
        assert.equal(effectivePermissionMode('always', 'dontAsk', true), 'dontAsk', 'refuses rather than accepts');
        assert.equal(effectivePermissionMode('always', 'acceptEdits', false), 'acceptEdits', 'without built-ins as before');
        assert.equal(effectivePermissionMode('never', 'acceptEdits', true), 'bypassPermissions');
        assert.match(permissionModeOverride('always', 'acceptEdits', true) ?? '', /acceptEdits.*ignored.*built-in/);
        assert.equal(permissionModeOverride('always', 'acceptEdits', false), undefined);
    });
});
