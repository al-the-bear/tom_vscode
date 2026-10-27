/**
 * tomAi_getQuestWindowStatus (src/tools/quest-window-status-tools.ts) against a fake access; the answer's content
 * is tested in src/utils/__tests__/questWindowStatus.test.ts.
 *
 *   QS-6 an unknown or malformed quest is refused; `quest` narrows the answer to that quest; without it every quest
 *        with a live window is listed; the tool is read-only
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { GET_QUEST_WINDOW_STATUS_TOOL, getQuestWindowStatusImpl, type QuestWindowStatusAccess } from '../quest-window-status-tools.js';
import { withTiming } from './_timing.js';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const fresh = new Date(NOW - 5_000).toISOString();

const access: QuestWindowStatusAccess = {
    questExists: (q) => ['vscode_extension', 'tom_uam', 'cli_tools'].includes(q),
    snapshot: () => ({
        states: [
            { windowId: 'a_m1', workspace: 'vscode_extension', activeQuest: 'vscode_extension', host: 'mbp', heartbeat: fresh },
            { windowId: 'b_m1', workspace: 'tom_uam', activeQuest: 'tom_uam', host: 'mbp', heartbeat: fresh },
        ],
        sessionsOf: () => [],
        config: { profiles: [{ id: 'opus', name: 'Opus', isDefault: true }] },
        noApiKey: new Set<string>(),
        thisHost: 'mbp',
        thisMachine: 'm1',
        thisWindowId: 'a_m1',
        nowMs: NOW,
    }),
};

describe('tomAi_getQuestWindowStatus', () => {
    test('QS-6: the tool', async () => {
        const refused = JSON.parse(await getQuestWindowStatusImpl(access, { quest: 'nope' }));
        assert.deepEqual([refused.ok, refused.code], [false, 'unknownQuest']);
        assert.equal(JSON.parse(await getQuestWindowStatusImpl(access, { quest: '../x' })).code, 'unknownQuest');
        const one = JSON.parse(await withTiming('tomAi_getQuestWindowStatus:typical', () => getQuestWindowStatusImpl(access, { quest: 'tom_uam' })));
        assert.deepEqual([one.ok, one.windows.map((w: { windowId: string }) => w.windowId), one.quests.map((q: { quest: string }) => q.quest)],
            [true, ['b_m1'], ['tom_uam']]);
        const quiet = JSON.parse(await getQuestWindowStatusImpl(access, { quest: 'cli_tools' }));
        assert.deepEqual([quiet.windows, quiet.quests.map((q: { quest: string }) => q.quest)], [[], ['cli_tools']], 'a quest with no window');
        const all = JSON.parse(await getQuestWindowStatusImpl(access, {}));
        assert.deepEqual(all.quests.map((q: { quest: string }) => q.quest), ['tom_uam', 'vscode_extension'], 'every quest with a live window');
        assert.deepEqual(all.profiles, [{ id: 'opus', name: 'Opus', transport: 'direct', isDefault: true, noApiKey: false }]);
        assert.equal(GET_QUEST_WINDOW_STATUS_TOOL.readOnly, true);
        assert.equal(GET_QUEST_WINDOW_STATUS_TOOL.name, 'tomAi_getQuestWindowStatus');
    });
});
