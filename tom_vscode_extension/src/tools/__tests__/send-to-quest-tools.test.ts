/**
 * tomAi_sendItemToQuest (src/tools/send-to-quest-tools.ts) against a fake access.
 *
 *   SQ-1 refused: no quest, an unknown quest, this window's own quest, an unknown profile, a session the target does
 *        not have (naming the sessions there are), session and newSession together, a newSession whose base is
 *        missing, whose name is taken or malformed, whose lifetime or profile is unknown; nothing is delivered then
 *   SQ-2 delivered: the inbox item holds what the sender said and who sent it; `targetRunning` and the windows follow
 *        the live heartbeats; the file goes to a running window's workspace, else the quest's own
 *   SQ-3 the tool is a write tool with the inputs the todo names
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { SEND_ITEM_TO_QUEST_TOOL, sendItemToQuestImpl, type QuestSendAccess, type TargetWindow } from '../send-to-quest-tools.js';
import type { InboxItem } from '../../utils/questInbox.js';
import type { SessionRecord } from '../../utils/agentSdkSessions.js';
import { withTiming } from './_timing.js';

function fakeAccess(opts: { windows?: TargetWindow[]; sessions?: SessionRecord[] } = {}) {
    const delivered: Array<{ workspace: string; item: InboxItem }> = [];
    const access: QuestSendAccess = {
        currentQuest: () => 'vscode_extension',
        questExists: (q) => ['vscode_extension', 'tom_uam'].includes(q),
        profileExists: (id) => ['opus-direct', 'haiku-sdk'].includes(id),
        listSessions: () => opts.sessions ?? [{ name: 'prep', mode: 'continue' }, { name: 'walk', mode: 'per-prompt' }],
        liveWindows: () => opts.windows ?? [],
        sender: () => ({ windowId: 'me_1234', host: 'mbp' }),
        deliver: (workspace, item) => { delivered.push({ workspace, item }); return `/q/${workspace}.inbox.queue.yaml`; },
        now: () => new Date('2026-10-27T12:00:00.000Z'),
    };
    return { access, delivered };
}

async function call(access: QuestSendAccess, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return JSON.parse(await sendItemToQuestImpl(access, input as never));
}

describe('tomAi_sendItemToQuest', () => {
    test('SQ-1: refusals', async () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ quest: '', text: 'x' }, 'invalidQuest'],
            [{ quest: 'nope', text: 'x' }, 'unknownQuest'],
            [{ quest: '../etc', text: 'x' }, 'unknownQuest'],
            [{ quest: 'vscode_extension', text: 'x' }, 'ownQuest'],
            [{ quest: 'tom_uam', text: 'x', anthropicProfileId: 'gone' }, 'unknownProfile'],
            [{ quest: 'tom_uam', text: 'x', session: 'missing' }, 'unknownSession'],
            [{ quest: 'tom_uam', text: 'x', session: 'walk', newSession: { basedOn: 'prep' } }, 'invalidSession'],
            [{ quest: 'tom_uam', text: 'x', newSession: { basedOn: 'missing' } }, 'unknownSession'],
            [{ quest: 'tom_uam', text: 'x', newSession: { basedOn: 'prep', name: 'walk' } }, 'invalidSession'],
            [{ quest: 'tom_uam', text: 'x', newSession: { basedOn: 'prep', name: 'bad name' } }, 'invalidSession'],
            [{ quest: 'tom_uam', text: 'x', newSession: { basedOn: 'prep', lifetime: 'sometimes' } }, 'invalidSession'],
            [{ quest: 'tom_uam', text: 'x', newSession: { basedOn: 'prep', profile: 'gone' } }, 'unknownProfile'],
        ];
        for (const [input, code] of cases) {
            const { access, delivered } = fakeAccess();
            const r = await call(access, input);
            assert.equal(r.ok, false, JSON.stringify(input));
            assert.equal(r.code, code, JSON.stringify(input));
            assert.deepEqual(delivered, [], 'nothing delivered');
        }
        const { access } = fakeAccess();
        assert.deepEqual((await call(access, { quest: 'tom_uam', text: 'x', session: 'missing' })).sessions, ['prep', 'walk'],
            'the sessions there are');
        assert.equal((await call(access, { quest: 'tom_uam', text: '  ' })).ok, false, 'no text');
    });

    test('SQ-2: delivered', async () => {
        const quiet = fakeAccess();
        const r = await withTiming('tomAi_sendItemToQuest:typical', () => call(quiet.access, {
            quest: 'tom_uam', text: 'Do X', anthropicProfileId: 'opus-direct', doneNotificationPrompt: 'back: ${itemOutcome}',
            pauseAfter: true, newSession: { basedOn: 'prep', lifetime: 'per-iteration', profile: 'haiku-sdk' },
        }));
        assert.deepEqual(r, {
            ok: true,
            delivered: '/q/tom_uam.inbox.queue.yaml',
            targetRunning: false,
            targetWindows: [],
            note: 'No window of "tom_uam" is running; the item is queued when one starts.',
        });
        assert.deepEqual(quiet.delivered, [{
            workspace: 'tom_uam',
            item: {
                text: 'Do X',
                anthropicProfileId: 'opus-direct',
                doneNotificationPrompt: 'back: ${itemOutcome}',
                pauseAfter: true,
                newSession: { basedOn: 'prep', lifetime: 'per-iteration', profile: 'haiku-sdk' },
                from: { quest: 'vscode_extension', windowId: 'me_1234', host: 'mbp', sentAt: '2026-10-27T12:00:00.000Z' },
            },
        }]);
        const running = fakeAccess({ windows: [{ windowId: 'w9', workspace: 'tom_uam_ws' }] });
        const r2 = await call(running.access, { quest: 'tom_uam', text: 'Hi', session: 'walk' });
        assert.equal(r2.targetRunning, true);
        assert.deepEqual(r2.targetWindows, [{ windowId: 'w9', workspace: 'tom_uam_ws' }]);
        assert.equal(running.delivered[0].workspace, 'tom_uam_ws', "the running window's workspace");
        assert.equal(running.delivered[0].item.session, 'walk');
    });

    test('SQ-3: the definition', () => {
        assert.equal(SEND_ITEM_TO_QUEST_TOOL.name, 'tomAi_sendItemToQuest');
        assert.equal(SEND_ITEM_TO_QUEST_TOOL.readOnly, false, 'a write tool: the MCP read-only floor does not serve it');
        const props = Object.keys((SEND_ITEM_TO_QUEST_TOOL.inputSchema as { properties: object }).properties);
        assert.deepEqual(props.sort(), ['anthropicProfileId', 'doneNotificationPrompt', 'newSession', 'pauseAfter', 'quest', 'session', 'template', 'text']);
    });
});
