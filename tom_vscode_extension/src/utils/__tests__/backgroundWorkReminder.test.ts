/**
 * The background-work reminder (utils/backgroundWorkReminder.ts, services/backgroundCommandWait.ts, the Agent SDK
 * transport and the direct API's background wait; vscimpb143).
 *
 *   BW-1 the default reminder: the work listed (what, id, command, output file), since when, the limit; it says
 *        the turn is not finished and to wait actively, check the result and answer again
 *   BW-2 the template: the Status Page's choice (assistPrompts.selected.backgroundWork) with its placeholders; a
 *        template whose text is empty sends no reminder; nothing running: none
 *   BW-3 once per wait: the same work is reminded about once; new work (a later wait) gets it again
 *   BW-4 the direct API's command streams: a reminder for the running ones (not for ended ones), none with
 *        waiting off (limit 0) or an empty template, once
 *   BW-5 the Agent SDK input channel: the wait begins (idle with a background task) and the reminder pushed then
 *        goes into the same query as a user message; the wait goes on until the task ends
 *   BW-6 the wiring: the transport pushes it on the `waiting` event, once; the handler passes it for queue
 *        sends and continues a direct turn with it before waiting; the docs
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { backgroundWorkLines, backgroundWorkReminder, localMinute, takeReminderFor } from '../backgroundWorkReminder';
import { ASSIST_PROMPT_INFO, type AssistPromptsSection } from '../assistPrompts';
import type { BackgroundWaitState } from '../backgroundWait';
import { reminderForRunningCommands } from '../../services/backgroundCommandWait';
import { QueryInputChannel, type SdkPromptMessage } from '../../services/agent-sdk-input-channel';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SINCE = '2026-11-17T09:05:00.000Z';
const state: BackgroundWaitState = {
    since: SINCE,
    limitMinutes: 360,
    items: [
        { id: 'b1x', kind: 'task', description: 'npm test', command: 'npm test 2>&1 | tail', outputFile: '/tmp/b1x.output' },
        { id: 'cmd-2', kind: 'command', description: 'dart test', command: 'dart test' },
    ],
};

describe('the background-work reminder', () => {
    test('BW-1: the default reminder', () => {
        const text = backgroundWorkReminder(undefined, state)!;
        assert.match(text, /^\*\*Your turn is not finished: work you started in the background is still running\.\*\*/);
        assert.ok(text.includes(`waited for since ${localMinute(SINCE)}; the queue waits at most 360 minutes`));
        assert.ok(text.includes('- npm test [b1x] — command `npm test 2>&1 | tail` — output `/tmp/b1x.output`\n- dart test [cmd-2]'), text);
        assert.match(text, /Check its progress periodically[\s\S]*poll until it has ended[\s\S]*check the result[\s\S]*answer again, with the result\. Do not start new work while it runs\./);
        assert.equal(backgroundWorkLines([{ id: 'x', kind: 'task', description: '' }]), '- x [x]');
        assert.match(localMinute(SINCE), /^2026-11-17 \d\d:05$/);
    });

    test('BW-2: the template from the config', () => {
        const section: AssistPromptsSection = {
            selected: { backgroundWork: 'short' },
            templates: [{ id: 'short', name: 'Short', template: 'Wait for ${backgroundWork} (since ${waitingSince}, max ${limitMinutes} min) — ${other}' }],
        };
        assert.equal(backgroundWorkReminder(section, { ...state, items: [state.items[1]] }), `Wait for - dart test [cmd-2] (since ${localMinute(SINCE)}, max 360 min) — \${other}`);
        assert.equal(backgroundWorkReminder({ selected: { backgroundWork: 'off' }, templates: [{ id: 'off', name: 'Off', template: '  \n' }] }, state), undefined, 'empty: no reminder');
        assert.equal(backgroundWorkReminder({ templates: [{ id: 'background-work-reminder', name: 'x', template: '' }] }, state), undefined, 'the default emptied: no reminder');
        assert.equal(backgroundWorkReminder(undefined, { ...state, items: [] }), undefined);
        assert.deepEqual(Object.keys(ASSIST_PROMPT_INFO.backgroundWork.placeholders), ['backgroundWork', 'waitingSince', 'limitMinutes']);
    });

    test('BW-3: once per wait', () => {
        const reminded = new Set<string>();
        assert.equal(takeReminderFor(state.items, reminded), true);
        assert.equal(takeReminderFor(state.items, reminded), false, 'the same wait');
        assert.equal(takeReminderFor([state.items[0]], reminded), false);
        assert.equal(takeReminderFor([...state.items, { id: 'new', kind: 'command', description: 'later' }], reminded), true, 'new work: again');
    });

    test('BW-4: the direct API\'s command streams', () => {
        const cmds = [
            { handle: 'cmd-1', command: 'npm test', running: true },
            { handle: 'cmd-0', command: 'old', running: false },
        ] as never[];
        const reminded = new Set<string>();
        const build = (s: BackgroundWaitState): string | undefined => backgroundWorkReminder(undefined, s);
        const text = reminderForRunningCommands(cmds, 360, Date.parse(SINCE), reminded, build)!;
        assert.ok(text.includes('- npm test [cmd-1]'));
        assert.ok(!text.includes('cmd-0'), 'an ended command is not listed');
        assert.equal(reminderForRunningCommands(cmds, 360, Date.parse(SINCE), reminded, build), undefined, 'once');
        assert.equal(reminderForRunningCommands(cmds, 0, Date.parse(SINCE), new Set(), build), undefined, 'waiting off');
        assert.equal(reminderForRunningCommands(cmds, 360, Date.parse(SINCE), new Set(), () => undefined), undefined, 'empty template');
        const notRecorded = new Set<string>();
        reminderForRunningCommands(cmds, 360, Date.parse(SINCE), notRecorded, () => undefined);
        assert.equal(notRecorded.size, 0, 'no reminder sent: nothing recorded');
    });

    test('BW-5: the Agent SDK input channel takes it into the same query', async () => {
        const events: string[] = [];
        let channel!: QueryInputChannel;
        channel = new QueryInputChannel('do the work', {
            graceMs: 50,
            backgroundLimitMs: 60_000,
            onEvent: (e) => {
                events.push(e.kind);
                if (e.kind === 'waiting') { channel.push('REMINDER: wait for b1x'); }
            },
        });
        const stream = channel.messages();
        const first = (await stream.next()).value as SdkPromptMessage;
        assert.equal(first.message.content, 'do the work');
        channel.observe({ type: 'system', subtype: 'session_state_changed', state: 'running' });
        channel.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1x', task_type: 'local_bash', description: 'npm test' }] });
        channel.observe({ type: 'result', user_message_uuid: channel.uuid, result: 'started the tests' });
        channel.observe({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
        assert.deepEqual(events, ['waiting']);
        assert.ok(channel.backgroundWait(), 'the wait has begun');
        const second = (await stream.next()).value as SdkPromptMessage;
        assert.equal(second.message.content, 'REMINDER: wait for b1x', 'the reminder goes into the same query');
        channel.observe({ type: 'system', subtype: 'session_state_changed', state: 'running' });
        channel.observe({ type: 'result', user_message_uuid: second.uuid, result: 'tests passed: 12/12' });
        channel.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
        channel.observe({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
        assert.equal(channel.closed, true);
        assert.deepEqual(events, ['waiting', 'done'], 'one wait, one reminder');
    });

    test('BW-6: the wiring', () => {
        const src = (rel: string): string => fs.readFileSync(path.join(EXT, rel), 'utf8');
        const transport = src('src/handlers/agent-sdk-transport.ts');
        assert.match(transport, /if \(event\.kind === 'waiting' && params\.backgroundReminder\) \{[\s\S]{0,400}input\.push\(text\)/);
        const handler = src('src/handlers/anthropic-handler.ts');
        assert.match(handler, /\.\.\.\(options\.source === 'queue' \? \{ backgroundReminder: \(state: BackgroundWaitState\) => backgroundWorkReminder\(loadSendToChatConfig\(\)\?\.assistPrompts, state\) \} : \{\}\)/);
        assert.match(handler, /const reminder = reminderForRunningCommands\(commandsOfOwner\(owner\), limit, Date\.now\(\), reminded,[\s\S]{0,700}return \{ continueWith: reminder \};[\s\S]{0,40}let announced = false;/, 'before the wait');
        assert.match(src('doc/user_guide.md'), /background-work reminder/i);
        assert.match(src('src/config/tom_vscode_extension.schema.json'), /"backgroundWork": \{ "type": "string"/);
    });
});
