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
 *   PM-7 "Accept edits" (CC-9), per tool class: file edits (ours and the built-ins) go through; commands, git,
 *        deleting and every other writer ask; readers never ask; "Always" and "Never" as before
 *   PM-8 "Accept edits" on the Agent SDK runs in its acceptEdits mode (a configured plan stays) and names an
 *        overridden configured mode; a stored value other than the three reads as Always
 *   PM-9 the setting everywhere: the schema's enum, sendToChatConfig.ts, the profile editor's options, its
 *        save and its help
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { builtInToolNeedsApproval, effectivePermissionMode, FILE_EDIT_TOOLS, parseToolApprovalMode, permissionModeOverride, toolNeedsApproval, TOOL_APPROVAL_MODES } from '../agentSdkPermissionMode';

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
        assert.match(transport, /const asks = toolNeedsApproval\(approvalMode, bare, undefined\);/, 'the built-ins go through the approval (CC-2), by the mode (CC-9)');
        assert.match(transport, /const needsApproval = toolNeedsApproval\(approvalMode, bare, def\);/, 'the tomAi_* tools by the same rule');
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

    test('PM-7: Accept edits, per tool class', () => {
        const writer = { readOnly: false };
        const reader = { readOnly: true };
        const fileEdits: Array<[string, typeof writer | undefined]> = [
            ['tomAi_editFile', writer], ['tomAi_multiEditFile', writer], ['tomAi_createFile', writer], ['tomAi_moveFile', writer],
            ['tomAi_applyEdit', writer], ['tomAi_notebookEdit', writer], ['tomAi_rename', writer],
            ['Edit', undefined], ['Write', undefined], ['MultiEdit', undefined], ['NotebookEdit', undefined],
        ];
        const commands: Array<[string, typeof writer | undefined]> = [['tomAi_runCommand', writer], ['tomAi_runCommandStream', writer], ['Bash', undefined], ['KillShell', undefined]];
        const otherWriters: Array<[string, typeof writer | undefined]> = [['tomAi_gitWrite', writer], ['tomAi_deleteFile', writer], ['tomAi_saveMemory', writer], ['tomAi_updateQuestTodo', writer]];
        const readers: Array<[string, typeof writer | undefined]> = [['tomAi_readFile', reader], ['tomAi_gitRead', reader], ['Read', undefined], ['Grep', undefined]];
        for (const [name, def] of fileEdits) {
            assert.equal(toolNeedsApproval('acceptEdits', name, def), false, `file edit ${name}`);
            assert.equal(toolNeedsApproval('always', name, def), true, `always asks ${name}`);
        }
        for (const [name, def] of [...commands, ...otherWriters]) {
            assert.equal(toolNeedsApproval('acceptEdits', name, def), true, `asks ${name}`);
        }
        for (const [name, def] of [...fileEdits, ...commands, ...otherWriters, ...readers]) {
            assert.equal(toolNeedsApproval('never', name, def), false, `never ${name}`);
        }
        for (const [name, def] of readers) {
            assert.equal(toolNeedsApproval('acceptEdits', name, def), false, `reader ${name}`);
            assert.equal(toolNeedsApproval('always', name, def), false, `reader ${name}`);
        }
        assert.equal(toolNeedsApproval('always', 'tomAi_writeChatVariable', { readOnly: false, requiresApproval: false }), false, 'a writer that opts out');
        assert.equal(FILE_EDIT_TOOLS.has('tomAi_deleteFile'), false, 'deleting is not an edit');
    });

    test('PM-8: Accept edits on the Agent SDK; stored values', () => {
        assert.equal(effectivePermissionMode('acceptEdits', undefined, true), 'acceptEdits');
        assert.equal(effectivePermissionMode('acceptEdits', 'bypassPermissions', true), 'acceptEdits');
        assert.equal(effectivePermissionMode('acceptEdits', 'default', false), 'acceptEdits');
        assert.equal(effectivePermissionMode('acceptEdits', 'plan', true), 'plan');
        assert.match(permissionModeOverride('acceptEdits', 'bypassPermissions', true) ?? '', /bypassPermissions is ignored.*Accept edits.*acceptEdits/);
        assert.equal(permissionModeOverride('acceptEdits', 'default', true), undefined);
        assert.equal(permissionModeOverride('acceptEdits', 'acceptEdits', true), undefined);
        assert.deepEqual(['always', 'acceptEdits', 'never', 'sometimes', undefined].map(parseToolApprovalMode), ['always', 'acceptEdits', 'never', 'always', 'always']);
        assert.deepEqual(TOOL_APPROVAL_MODES, ['always', 'acceptEdits', 'never']);
    });

    test('PM-9: the setting in the schema, the config type and the profile editor', () => {
        const root = join(__dirname, '..', '..', '..', 'src');
        const schema = JSON.parse(readFileSync(join(root, 'config', 'tom_vscode_extension.schema.json'), 'utf-8')) as Record<string, unknown>;
        const enums: unknown[] = [];
        const walk = (n: unknown): void => {
            if (!n || typeof n !== 'object') { return; }
            const o = n as Record<string, unknown>;
            if (o.toolApprovalMode && typeof o.toolApprovalMode === 'object') { enums.push((o.toolApprovalMode as { enum?: unknown }).enum); }
            Object.values(o).forEach(walk);
        };
        walk(schema);
        assert.ok(enums.length > 0);
        for (const e of enums) { assert.deepEqual(e, ['always', 'acceptEdits', 'never']); }
        assert.match(readFileSync(join(root, 'utils', 'sendToChatConfig.ts'), 'utf-8'), /toolApprovalMode\?: 'always' \| 'acceptEdits' \| 'never';/);
        const editor = readFileSync(join(root, 'handlers', 'globalTemplateEditor-handler.ts'), 'utf-8');
        assert.match(editor, /\{ value: 'acceptEdits', label: 'Accept edits — file edits go through, commands and other writers ask' \}/);
        assert.match(editor, /const toolApprovalMode = parseToolApprovalMode\(values\.toolApprovalMode\);/, 'saved as chosen');
        assert.match(editor, /const approvalMode = parseToolApprovalMode\(p\.toolApprovalMode\);/, 'shown as stored');
        assert.match(editor, /<strong>Accept edits<\/strong> lets the file edits through/);
    });
});
