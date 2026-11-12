/**
 * Agent SDK queue runs refuse Bash commands that detach from their call (vscimpb56): the queue waits for the
 * CLI's background tasks, and a detached command is none.
 *
 *   DC-1 refused: a trailing `&`, a `&` in the middle, `nohup`, `setsid`, `disown`, `screen -d…`, `tmux new … -d`,
 *        `daemonize`, a backgrounded subshell
 *   DC-2 passing: lists and redirections (`a && b`, `cmd 2>&1`, `[ -f x ] && y`, `&>`, `>&2`, `|&`), an `&` inside
 *        quotes or a comment, the words inside other words (`nohupper`), `screen -r`, `tmux attach`
 *   DC-3 the refusal says to use run_in_background and that the queue waits for it
 *   DC-4 the PreToolUse callback denies a detaching Bash and passes the rest; withDetachGuard keeps other hooks
 *   DC-5 a queue run offers no tomAi_runCommandStream and disallows Monitor
 */

/* eslint-disable @typescript-eslint/naming-convention -- the SDK's hook fields */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { DETACHING_REFUSAL, detachingCommandReason, detachingRefusalMessage } from '../detachingCommand.js';
import { QUEUE_RUN_DISALLOWED_BUILT_INS, queueRunTools, refuseDetachingBash, withDetachGuard } from '../agentSdkQueueRun.js';

describe('detaching Bash commands', () => {
    test('DC-1: refused', () => {
        const refused: Array<[string, RegExp]> = [
            ['npm run build &', /`&`/],
            ['./server.sh & sleep 1; echo up', /`&`/],
            ['nohup ./long.sh > out.log 2>&1', /nohup/],
            ['cd x && nohup make', /nohup/],
            ['setsid ./run.sh', /setsid/],
            ['./run.sh & disown', /disown/],
            ['disown -a', /disown/],
            ['screen -dmS build make', /screen -d/],
            ['screen -d -m ./job', /screen -d/],
            ['tmux new -d -s w ./job', /tmux new -d/],
            ['tmux new-session -s w -d "make"', /tmux new -d/],
            ['daemonize /usr/bin/job', /daemonize/],
            ['(sleep 600; touch done) &', /`&`/],
            ['for f in *; do gzip "$f" & done', /`&`/],
        ];
        for (const [cmd, why] of refused) {
            const reason = detachingCommandReason(cmd);
            assert.ok(reason, `refused: ${cmd}`);
            assert.match(reason!, why, cmd);
        }
    });

    test('DC-2: passing', () => {
        const passing = [
            'a && b',
            'cmd 2>&1',
            '[ -f x ] && y',
            'make &> build.log',
            'echo oops >&2',
            'cmd |& tee log',
            'npm test 2>&1 | tail -20 && echo ok || echo failed',
            'echo "a & b"',
            "grep -n 'x & y' file",
            'echo done # runs in the foreground & stays',
            'echo nohupper setsidish',
            'screen -r build',
            'tmux attach -t w',
            'git log --format="%h & %s"',
            'until [ -f done ]; do sleep 5; done',
            'echo a\\&b',
        ];
        for (const cmd of passing) {
            assert.equal(detachingCommandReason(cmd), undefined, `passes: ${cmd}`);
        }
    });

    test('DC-3: the refusal', () => {
        assert.equal(DETACHING_REFUSAL, 'start it with run_in_background instead — the queue waits for it');
        assert.match(detachingRefusalMessage('`nohup`'), /keep running after its call ends \(`nohup`\).*start it with run_in_background instead — the queue waits for it\./);
    });

    test('DC-4: the PreToolUse callback and the hook map', async () => {
        const signal = new AbortController().signal;
        const denied = await refuseDetachingBash({ tool_name: 'Bash', tool_input: { command: 'nohup ./x &' } }, 'tu1', { signal });
        const out = denied.hookSpecificOutput as { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
        assert.equal(out.hookEventName, 'PreToolUse');
        assert.equal(out.permissionDecision, 'deny');
        assert.match(out.permissionDecisionReason, /run_in_background/);
        assert.deepEqual(await refuseDetachingBash({ tool_name: 'Bash', tool_input: { command: 'npm test 2>&1' } }, 'tu2', { signal }), {});
        assert.deepEqual(await refuseDetachingBash({ tool_name: 'Bash', tool_input: {} }, 'tu3', { signal }), {});

        const own = async (): Promise<Record<string, unknown>> => ({});
        const merged = withDetachGuard({ PreToolUse: [{ matcher: 'Edit', hooks: [own] }], Stop: [{ hooks: [own] }] });
        assert.deepEqual(merged.PreToolUse.map((e) => e.matcher), ['Edit', 'Bash'], 'the project\'s hook first, the guard after it');
        assert.equal(merged.PreToolUse[1].hooks[0], refuseDetachingBash);
        assert.equal(merged.Stop.length, 1, 'other events kept');
        assert.deepEqual(withDetachGuard({}).PreToolUse.map((e) => e.matcher), ['Bash']);
    });

    test('DC-5: what a queue run offers', () => {
        const tools = [{ name: 'tomAi_runCommandStream' }, { name: 'tomAi_readCommandOutput' }, { name: 'tomAi_killCommand' }, { name: 'tomAi_readFile' }];
        assert.deepEqual(queueRunTools(tools).map((t) => t.name), ['tomAi_readCommandOutput', 'tomAi_killCommand', 'tomAi_readFile']);
        assert.deepEqual(QUEUE_RUN_DISALLOWED_BUILT_INS, ['Monitor']);
    });
});
