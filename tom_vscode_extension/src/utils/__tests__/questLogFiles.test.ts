/**
 * Tests for the quest log-file catalogue that backs two viewers: the @CHAT Logs
 * section (one session on this machine: Trail, Live Trail, Live Source) and the
 * quest-document sub-tabs of @WS Documentation (Quest Progress, Quest Overview,
 * Quest Notes, Quest Refresh, DocUpdate, Deferred, Q&A).
 *
 * The catalogue is pure, so the sub-tab → file mapping, the quest-id
 * sanitisation and the tail window can be pinned down here rather than by
 * clicking through a webview. Four contracts matter most:
 *
 *   - **Every tab resolves to exactly one deterministic file.** The quest
 *     folder has no globbing: `progress.<quest>.md`, this host's
 *     `trail.<host>.md` for the Trail tab, and the two live tabs both point at
 *     the session's `live-trail.md`.
 *   - **A tab names the *area* it reads from, not just a file name.** The
 *     quest documents read the quest folder; the Logs tabs its `history/`.
 *   - **The read window never splits a line.** The viewer reads only one slice
 *     of a multi-hundred-KB file; cutting mid-line would corrupt the first or
 *     last rendered line, so the slice is snapped to a newline at whichever end
 *     was cut.
 *   - **Each tab is read from the end its newest content is at.** The live
 *     trail is appended to, so its slice is the file's tail; the quest
 *     documents are prepended to or rewritten wholesale, so theirs is the
 *     file's head; the Trail tab shows its turns newest first, at the top.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    QUEST_LOG_TABS,
    DEFAULT_QUEST_LOG_TAB_ID,
    MAX_QUEST_LOG_BYTES,
    isQuestLogTabId,
    questLogLocation,
    questLogSession,
    questLogViewKey,
    questLogTabsOf,
    isSessionTab,
    computeTailStart,
    trimToLineStart,
    trimToLineEnd,
    type QuestLogTabId,
} from '../questLogFiles.js';
import { hostSlugOf } from '../hostSlug.js';

describe('QUEST_LOG_TABS catalogue', () => {
    test('declares exactly the ten sub-tabs, in order: the Logs tabs, then the quest documents', () => {
        assert.deepEqual(
            QUEST_LOG_TABS.map(t => t.id),
            [
                'turns', 'mdTrail', 'trail',
                'progress', 'overview', 'notes', 'refresh', 'docUpdate', 'deferred',
                'questions',
            ],
        );
        assert.deepEqual(questLogTabsOf('logs').map(t => t.id), ['turns', 'mdTrail', 'trail']);
        assert.deepEqual(questLogTabsOf('docs').map(t => t.id),
            ['progress', 'overview', 'notes', 'refresh', 'docUpdate', 'deferred', 'questions']);
        assert.equal(QUEST_LOG_TABS.find(t => t.id === 'questions')?.label, 'Q&A');
        assert.deepEqual(QUEST_LOG_TABS.filter(t => isSessionTab(t.id)).map(t => t.id), questLogTabsOf('logs').map(t => t.id),
            'exactly the Logs tabs show a session');
    });

    test('labels match the names the panel shows: one Trail tab, no Prompts / Answers / Current Prompt', () => {
        assert.deepEqual(
            QUEST_LOG_TABS.map(t => t.label),
            [
                'Trail', 'Live Trail', 'Live Source',
                'Quest Progress', 'Quest Overview', 'Quest Notes', 'Quest Refresh', 'DocUpdate', 'Deferred',
                'Q&A',
            ],
        );
    });

    test('the Trail tab shows turns, Live Trail rendered markdown, every other tab highlighted source', () => {
        assert.deepEqual(QUEST_LOG_TABS.filter(t => t.view === 'turns').map(t => t.id), ['turns']);
        assert.deepEqual(QUEST_LOG_TABS.filter(t => t.view === 'rendered').map(t => t.id), ['mdTrail']);
        assert.deepEqual(QUEST_LOG_TABS.filter(t => t.view === 'source').map(t => t.id),
            ['trail', 'progress', 'overview', 'notes', 'refresh', 'docUpdate', 'deferred', 'questions']);
    });

    test('ids are unique', () => {
        const ids = QUEST_LOG_TABS.map(t => t.id);
        assert.equal(new Set(ids).size, ids.length);
    });

    test('the default tab is Trail and is part of the catalogue', () => {
        assert.equal(DEFAULT_QUEST_LOG_TAB_ID, 'turns');
        assert.equal(QUEST_LOG_TABS.some(t => t.id === DEFAULT_QUEST_LOG_TAB_ID), true);
    });

    test('each tab is read from the end its own file grows at', () => {
        // live-trail.md is appended to, so its newest content is at the bottom,
        // and so are the two journals — deferred steps and Q&A blocks are added
        // after the ones already there. The remaining quest documents are
        // prepended to or rewritten wholesale, so reading their tail would show
        // the oldest content. The Trail tab lists its turns newest first.
        const fromEnd = QUEST_LOG_TABS.filter(t => t.newestAt === 'end').map(t => t.id);
        assert.deepEqual(fromEnd, ['mdTrail', 'trail', 'deferred', 'questions']);

        const fromStart = QUEST_LOG_TABS.filter(t => t.newestAt === 'start').map(t => t.id);
        assert.deepEqual(fromStart, ['turns', 'progress', 'overview', 'notes', 'refresh', 'docUpdate']);
    });

    test('every tab carries a codicon name for the tab strip', () => {
        for (const tab of QUEST_LOG_TABS) {
            assert.equal(typeof tab.icon, 'string');
            assert.ok(tab.icon.length > 0, `tab ${tab.id} has no icon`);
        }
    });
});

describe('isQuestLogTabId', () => {
    test('accepts every catalogued id', () => {
        for (const tab of QUEST_LOG_TABS) {
            assert.equal(isQuestLogTabId(tab.id), true);
        }
    });

    test('rejects unknown / non-string values, the removed tabs included', () => {
        assert.equal(isQuestLogTabId('logs'), false);
        for (const gone of ['prompts', 'answers', 'currentPrompt']) {
            assert.equal(isQuestLogTabId(gone), false, `${gone} is no tab`);
        }
        assert.equal(isQuestLogTabId(''), false);
        assert.equal(isQuestLogTabId(undefined), false);
        assert.equal(isQuestLogTabId(null), false);
        assert.equal(isQuestLogTabId(7), false);
    });
});

describe('questLogLocation', () => {
    const cases: [QuestLogTabId, string][] = [
        ['progress', 'progress.vscode_extension.md'],
        ['overview', 'overview.vscode_extension.md'],
        ['notes', 'notes/quest-notes.md'],
        ['refresh', 'quest_refresh.vscode_extension.md'],
        ['docUpdate', 'quest_documentation_update.vscode_extension.md'],
        ['deferred', 'deferred.vscode_extension.md'],
        // This host's Q&A journal; decisions.<quest>.md is no tab.
        ['questions', `qa.${hostSlugOf()}.vscode_extension.md`],
    ];

    for (const [id, expected] of cases) {
        test(`${id} → quest folder / ${expected}`, () => {
            assert.deepEqual(
                questLogLocation(id, 'vscode_extension'),
                { area: 'quest', fileName: expected },
            );
        });
    }

    // The live trail is per session; the tabs show the queue's (`default`).
    const historyCases: [QuestLogTabId, string][] = [
        ['mdTrail', 'sessions/default@default/live-trail.md'],
        ['trail', 'sessions/default@default/live-trail.md'],
    ];

    for (const [id, expected] of historyCases) {
        test(`${id} → quest history folder / ${expected}`, () => {
            assert.deepEqual(
                questLogLocation(id, 'vscode_extension'),
                { area: 'questHistory', fileName: expected },
            );
        });
    }

    test('the Trail tab\'s file is this host\'s trail, whichever session is chosen', () => {
        const expected = { area: 'questHistory', fileName: `trail.${hostSlugOf()}.md` };
        assert.deepEqual(questLogLocation('turns', 'demo'), expected);
        assert.deepEqual(questLogLocation('turns', 'demo', 'chat'), expected);
    });

    test('the live tabs read the chosen session\'s storage', () => {
        assert.deepEqual(questLogLocation('mdTrail', 'demo', 'chat'), { area: 'questHistory', fileName: 'sessions/chat/live-trail.md' });
        assert.deepEqual(questLogLocation('trail', 'demo', 'tmp-261027-120000-a1'),
            { area: 'questHistory', fileName: 'sessions/tmp-261027-120000-a1/live-trail.md' });
        assert.equal(questLogLocation('trail', 'demo', '../../etc').fileName, 'sessions/default@default/live-trail.md', 'a bad name cannot leave the folder');
        assert.deepEqual(questLogLocation('mdTrail', 'demo', 'default@collab'), { area: 'questHistory', fileName: 'sessions/default@collab/live-trail.md' },
            'a run\'s session reads its own folder, not default\'s');
        assert.equal(questLogLocation('trail', 'demo', 'x@../etc').fileName, 'sessions/default@default/live-trail.md', 'an @ name cannot leave the folder either');
        assert.deepEqual(questLogLocation('progress', 'demo', 'chat'), { area: 'quest', fileName: 'progress.demo.md' }, 'a quest document has no session');
    });

    test('both live tabs read the same file — one rendered, one as source', () => {
        assert.deepEqual(
            questLogLocation('mdTrail', 'demo'),
            questLogLocation('trail', 'demo'),
        );
    });

    test('an empty quest id falls back to the "default" quest folder naming', () => {
        assert.equal(questLogLocation('progress', '').fileName, 'progress.default.md');
    });

    test('a quest id with path separators cannot escape the quest folder', () => {
        // The separators are what make an id dangerous — `..` on its own is a
        // legal file-name component, so it survives; `/` does not.
        const { fileName } = questLogLocation('overview', '../../etc');
        assert.equal(fileName.includes('/'), false);
        assert.equal(fileName.includes('\\'), false);
        assert.equal(fileName, 'overview..._.._etc.md');
    });
});

describe('questLogSession', () => {
    test('a session name is canonical; anything else is the default', () => {
        assert.equal(questLogSession('chat'), 'chat');
        assert.equal(questLogSession('default'), 'default@default');
        assert.equal(questLogSession('../evil'), 'default@default');
        assert.equal(questLogSession(undefined), 'default@default');
    });
});

/** The host caches what it last sent so an unchanged file costs one `stat`. */
describe('questLogViewKey', () => {
    test('different tabs never share a key', () => {
        const keys = QUEST_LOG_TABS.map(t => questLogViewKey(t.id));
        assert.equal(new Set(keys).size, QUEST_LOG_TABS.length);
    });

    test('a Logs tab has one key per session; a quest document has one', () => {
        assert.notEqual(questLogViewKey('mdTrail', 'chat'), questLogViewKey('mdTrail', 'default'),
            'switching the session must load the other session\'s file, not answer "unchanged"');
        assert.notEqual(questLogViewKey('turns', 'chat'), questLogViewKey('turns', 'walk'), 'the Trail tab too: one host file, a view per session');
        assert.equal(questLogViewKey('mdTrail'), questLogViewKey('mdTrail', 'default'), 'no session: the default one');
        assert.notEqual(questLogViewKey('mdTrail', 'default@collab'), questLogViewKey('mdTrail', 'default@another'), 'two runs\' sessions: two keys');
        assert.equal(questLogViewKey('turns', 'walk'), 'turns@walk');
        assert.equal(questLogViewKey('progress', 'walk'), 'progress', 'the quest documents are one set');
        assert.equal(questLogViewKey('trail', '../evil'), questLogViewKey('trail', 'default'), 'a bad name is the default');
    });
});

describe('trimToLineStart', () => {
    test('drops the partial first line so the view never starts mid-sentence', () => {
        assert.equal(trimToLineStart('ne line\nsecond\n'), 'second\n');
    });

    test('returns the text unchanged when it has no newline to snap to', () => {
        assert.equal(trimToLineStart('single fragment'), 'single fragment');
    });

    test('leaves text that already starts on a line boundary alone', () => {
        // No leading partial line to drop — the caller only trims when it
        // actually sliced into the middle of the file.
        assert.equal(trimToLineStart('\nsecond'), 'second');
    });
});

describe('trimToLineEnd', () => {
    test('drops the partial last line so the view never ends mid-sentence', () => {
        assert.equal(trimToLineEnd('first\nsecond\nthi'), 'first\nsecond\n');
    });

    test('returns the text unchanged when it has no newline to snap to', () => {
        assert.equal(trimToLineEnd('single fragment'), 'single fragment');
    });

    test('leaves text that already ends on a line boundary alone', () => {
        assert.equal(trimToLineEnd('first\nsecond\n'), 'first\nsecond\n');
    });
});

describe('computeTailStart', () => {
    test('reads the whole file when it fits in the window', () => {
        assert.equal(computeTailStart(1000, 4096), 0);
        assert.equal(computeTailStart(4096, 4096), 0);
    });

    test('starts at the last `maxBytes` of an oversized file', () => {
        assert.equal(computeTailStart(10_000, 4096), 10_000 - 4096);
    });

    test('never returns a negative offset for a degenerate size', () => {
        assert.equal(computeTailStart(0, 4096), 0);
        assert.equal(computeTailStart(-5, 4096), 0);
    });

    test('defaults to the module-wide tail window', () => {
        assert.equal(computeTailStart(MAX_QUEST_LOG_BYTES * 2), MAX_QUEST_LOG_BYTES);
        assert.ok(MAX_QUEST_LOG_BYTES >= 64 * 1024, 'tail window should hold a useful amount of trail');
    });
});
