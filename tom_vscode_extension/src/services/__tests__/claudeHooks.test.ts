/**
 * Claude Code hooks (ccparity_d_claudecode-6, CC-12 (a)):
 * services/claudeHooks.ts over fixture hooks — a small Node script that
 * records the JSON it gets on stdin and then allows, blocks or modifies as its
 * argument says.
 *
 *   HK-1 loading: the hooks of ~/.claude/settings.json (user), .claude/settings.json (project) and
 *        .claude/settings.local.json (local), each with its source, event, matcher, command and timeout (60 s
 *        by default); `sources` narrows them; an unreadable file, a non-command hook and an unknown event are left out
 *   HK-2 matching: the matcher is a regular expression over the whole tool name (`Edit|Write`, `Notebook.*`);
 *        none, '' and '*' match everything; for SessionStart it matches the source (startup, clear, …)
 *   HK-3 PreToolUse: the hook gets Claude Code's input JSON on stdin (session_id, transcript_path, cwd,
 *        hook_event_name, tool_name, tool_input) and CLAUDE_PROJECT_DIR; JSON `permissionDecision` allow / deny /
 *        ask, the legacy `decision` approve / block, exit code 2 (stderr the reason) and `updatedInput`
 *        (modify); deny wins over ask over allow
 *   HK-4 the other events: PostToolUse `decision: block` and `additionalContext`, exit 2 as feedback;
 *        UserPromptSubmit blocked by exit 2 or JSON, its plain stdout as context; Stop blocked with a reason;
 *        SessionStart's context; another exit code, a crash or a timeout is a non-blocking error shown to the
 *        user; `continue: false` stops with its stopReason; `systemMessage` is shown
 *   HK-5 the Agent SDK's callbacks: the same hooks as `{matcher, hooks: [callback]}` per event, a callback
 *        answering Claude Code's JSON (exit 2 → deny / block, plain stdout → additionalContext)
 */

/* eslint-disable @typescript-eslint/naming-convention -- Claude Code's settings and hook wire fields */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { hooksFor, loadHooks, runHooks, sdkHookCallbacks, type CommandHook } from '../claudeHooks';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hooks-')));
const home = path.join(base, 'home');
const ws = path.join(base, 'ws');
const log = path.join(base, 'stdin.log');
const script = path.join(base, 'hook.js');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(script, `
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ mode: process.argv[2], input: JSON.parse(input), projectDir: process.env.CLAUDE_PROJECT_DIR }) + '\\n');
    const out = (o) => process.stdout.write(JSON.stringify(o));
    switch (process.argv[2]) {
        case 'allow': out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'trusted' } }); break;
        case 'ask': out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }); break;
        case 'deny-json': out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'not here' } }); break;
        case 'legacy-block': out({ decision: 'block', reason: 'legacy no' }); break;
        case 'exit2': process.stderr.write('blocked by policy'); process.exit(2);
        case 'modify': out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { filePath: 'safe.txt' } } }); break;
        case 'post-block': out({ decision: 'block', reason: 'lint failed', hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'run the linter' } }); break;
        case 'stdout': process.stdout.write('Today is release day.'); break;
        case 'context': out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Project is in freeze.' } }); break;
        case 'stop-block': out({ decision: 'block', reason: 'Run the tests before stopping.' }); break;
        case 'fail': process.stderr.write('hook broke'); process.exit(1);
        case 'halt': out({ continue: false, stopReason: 'Budget exhausted', systemMessage: 'Stopping now' }); break;
        case 'sleep': setTimeout(() => {}, 10000); break;
        default: break;
    }
});
`);
const cmd = (mode: string): string => `node "${script}" ${mode}`;
const settings = (file: string, hooks: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hooks }));
};
const entries = (): Array<{ mode: string; input: Record<string, unknown>; projectDir: string }> =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const hook = (event: CommandHook['event'], mode: string, extra: Partial<CommandHook> = {}): CommandHook =>
    ({ event, command: cmd(mode), timeoutSec: 10, source: 'project', file: 'x', ...extra });
const opts = { cwd: ws, sessionId: 'quest:default', transcriptPath: '/t/live-trail.md' };

describe('Claude Code hooks', () => {
    test('HK-1: loading', () => {
        settings(path.join(home, '.claude', 'settings.json'), { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] });
        settings(path.join(ws, '.claude', 'settings.json'), {
            PreToolUse: [{ matcher: 'Bash|tomAi_runCommand', hooks: [{ type: 'command', command: 'echo pre', timeout: 5 }, { type: 'prompt', prompt: 'x' }] }],
            Nonsense: [{ hooks: [{ type: 'command', command: 'echo no' }] }],
        });
        fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), '{ not json');
        const all = loadHooks(ws, home);
        assert.deepEqual(all.map((h) => [h.source, h.event, h.matcher ?? '', h.command, h.timeoutSec]), [
            ['user', 'Stop', '', 'echo user', 60],
            ['project', 'PreToolUse', 'Bash|tomAi_runCommand', 'echo pre', 5],
        ]);
        assert.deepEqual(loadHooks(ws, home, ['project']).map((h) => h.source), ['project']);
        settings(path.join(ws, '.claude', 'settings.local.json'), { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo local' }] }] });
        assert.deepEqual(loadHooks(ws, home).map((h) => h.source), ['user', 'project', 'local']);
    });

    test('HK-2: matching', () => {
        const hooks = [
            hook('PreToolUse', 'a', { matcher: 'Edit|Write' }), hook('PreToolUse', 'b', { matcher: 'Notebook.*' }),
            hook('PreToolUse', 'c'), hook('PreToolUse', 'd', { matcher: '*' }), hook('PreToolUse', 'e', { matcher: '' }),
            hook('SessionStart', 'f', { matcher: 'startup' }), hook('PostToolUse', 'g'),
        ];
        const modes = (event: CommandHook['event'], value?: string) => hooksFor(hooks, event, value).map((h) => h.command.split(' ').pop());
        assert.deepEqual(modes('PreToolUse', 'Write'), ['a', 'c', 'd', 'e']);
        assert.deepEqual(modes('PreToolUse', 'MultiWrite'), ['c', 'd', 'e'], 'the whole name');
        assert.deepEqual(modes('PreToolUse', 'NotebookEdit'), ['b', 'c', 'd', 'e']);
        assert.deepEqual(modes('SessionStart', 'startup'), ['f']);
        assert.deepEqual(modes('SessionStart', 'clear'), []);
    });

    test('HK-3: PreToolUse', async () => {
        fs.rmSync(log, { force: true });
        const input = { tool_name: 'tomAi_editFile', tool_input: { filePath: 'a.txt' } };
        const allow = await runHooks([hook('PreToolUse', 'allow')], 'PreToolUse', input, opts);
        assert.equal(allow.decision, 'allow');
        const seen = entries()[0];
        assert.deepEqual(seen.input, {
            session_id: 'quest:default', transcript_path: '/t/live-trail.md', cwd: ws, hook_event_name: 'PreToolUse',
            tool_name: 'tomAi_editFile', tool_input: { filePath: 'a.txt' },
        });
        assert.equal(seen.projectDir, ws);
        const exit2 = await runHooks([hook('PreToolUse', 'exit2')], 'PreToolUse', input, opts);
        assert.deepEqual([exit2.decision, exit2.reason], ['deny', 'blocked by policy']);
        assert.deepEqual([(await runHooks([hook('PreToolUse', 'deny-json')], 'PreToolUse', input, opts)).reason], ['not here']);
        assert.equal((await runHooks([hook('PreToolUse', 'legacy-block')], 'PreToolUse', input, opts)).decision, 'deny');
        assert.equal((await runHooks([hook('PreToolUse', 'ask')], 'PreToolUse', input, opts)).decision, 'ask');
        const modify = await runHooks([hook('PreToolUse', 'modify')], 'PreToolUse', input, opts);
        assert.deepEqual(modify.updatedInput, { filePath: 'safe.txt' });
        const mixed = await runHooks([hook('PreToolUse', 'allow'), hook('PreToolUse', 'ask'), hook('PreToolUse', 'deny-json')], 'PreToolUse', input, opts);
        assert.equal(mixed.decision, 'deny', 'deny wins');
        assert.equal((await runHooks([hook('PreToolUse', 'allow'), hook('PreToolUse', 'ask')], 'PreToolUse', input, opts)).decision, 'ask');
        assert.equal((await runHooks([], 'PreToolUse', input, opts)).decision, undefined);
    });

    test('HK-4: the other events', async () => {
        const post = await runHooks([hook('PostToolUse', 'post-block')], 'PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: 'ok' }, opts);
        assert.deepEqual([post.block, post.reason, post.additionalContext], [true, 'lint failed', ['run the linter']]);
        const postExit2 = await runHooks([hook('PostToolUse', 'exit2')], 'PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: 'ok' }, opts);
        assert.deepEqual([postExit2.block, postExit2.reason], [true, 'blocked by policy']);
        const prompt = await runHooks([hook('UserPromptSubmit', 'exit2')], 'UserPromptSubmit', { prompt: 'hi' }, opts);
        assert.deepEqual([prompt.block, prompt.reason], [true, 'blocked by policy']);
        assert.equal(entries().pop()!.input.prompt, 'hi');
        assert.deepEqual((await runHooks([hook('UserPromptSubmit', 'stdout')], 'UserPromptSubmit', { prompt: 'hi' }, opts)).additionalContext, ['Today is release day.']);
        assert.deepEqual((await runHooks([hook('PreToolUse', 'stdout')], 'PreToolUse', { tool_name: 'x', tool_input: {} }, opts)).additionalContext, [], 'plain stdout is context only for prompts and sessions');
        const stop = await runHooks([hook('Stop', 'stop-block')], 'Stop', { stop_hook_active: false }, opts);
        assert.deepEqual([stop.block, stop.reason], [true, 'Run the tests before stopping.']);
        assert.equal(entries().pop()!.input.stop_hook_active, false);
        assert.deepEqual((await runHooks([hook('SessionStart', 'context')], 'SessionStart', { source: 'startup' }, opts)).additionalContext, ['Project is in freeze.']);
        const failed = await runHooks([hook('PreToolUse', 'fail')], 'PreToolUse', { tool_name: 'x', tool_input: {} }, opts);
        assert.equal(failed.decision, undefined, 'a failing hook does not block');
        assert.match(failed.userMessages.join(), /PreToolUse hook .*exit 1.*hook broke/);
        const slow = await runHooks([hook('PreToolUse', 'sleep', { timeoutSec: 1 })], 'PreToolUse', { tool_name: 'x', tool_input: {} }, opts);
        assert.match(slow.userMessages.join(), /timed out after 1 s/);
        const halt = await runHooks([hook('PostToolUse', 'halt')], 'PostToolUse', { tool_name: 'x', tool_input: {}, tool_response: '' }, opts);
        assert.deepEqual(halt.stop, { reason: 'Budget exhausted' });
        assert.deepEqual(halt.userMessages, ['Stopping now']);
    });

    test('HK-5: the Agent SDK callbacks', async () => {
        const callbacks = sdkHookCallbacks([hook('PreToolUse', 'exit2', { matcher: 'Bash' }), hook('UserPromptSubmit', 'stdout')], opts);
        assert.deepEqual(Object.keys(callbacks), ['PreToolUse', 'UserPromptSubmit']);
        assert.equal(callbacks.PreToolUse![0].matcher, 'Bash');
        const signal = new AbortController().signal;
        const pre = await callbacks.PreToolUse![0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }, 'tu', { signal });
        assert.deepEqual(pre, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked by policy' } });
        const prompt = await callbacks.UserPromptSubmit![0].hooks[0]({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, undefined, { signal });
        assert.deepEqual(prompt, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Today is release day.' } });
    });
});
