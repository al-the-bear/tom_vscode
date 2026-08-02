/**
 * Tests for the quest log-file catalogue that backs the @WS panel's Logs
 * section (nine sub-tabs: MD Trail, Trail, Prompts, Answers, Progress,
 * Overview, Notes, Refresh, DocUpdate).
 *
 * The catalogue is pure — no `vscode`, no `fs` — so the sub-tab → file-name
 * mapping, the quest-id sanitisation and the tail window can be pinned down
 * here rather than by clicking through a webview. Two contracts matter most:
 *
 *   - **Every tab resolves to exactly one deterministic file name.** The quest
 *     folder has no globbing: `progress.<quest>.md`, `<quest>.anthropic.
 *     prompts.md`, and the two trail tabs both point at `live-trail.md`.
 *   - **The tail window never splits a line.** The viewer reads only the last
 *     slice of a multi-hundred-KB trail; starting mid-line would corrupt the
 *     first rendered line, so the start offset is snapped forward to a newline.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    QUEST_LOG_TABS,
    DEFAULT_QUEST_LOG_TAB_ID,
    MAX_QUEST_LOG_BYTES,
    isQuestLogTabId,
    questLogFileName,
    computeTailStart,
    trimToLineStart,
    type QuestLogTabId,
} from '../questLogFiles.js';

describe('QUEST_LOG_TABS catalogue', () => {
    test('declares exactly the nine requested sub-tabs, in order', () => {
        assert.deepEqual(
            QUEST_LOG_TABS.map(t => t.id),
            ['mdTrail', 'trail', 'prompts', 'answers', 'progress', 'overview', 'notes', 'refresh', 'docUpdate'],
        );
    });

    test('labels match the names the panel shows', () => {
        assert.deepEqual(
            QUEST_LOG_TABS.map(t => t.label),
            ['MD Trail', 'Trail', 'Prompts', 'Answers', 'Progress', 'Overview', 'Notes', 'Refresh', 'DocUpdate'],
        );
    });

    test('only MD Trail is rendered markdown; every other tab is highlighted source', () => {
        const rendered = QUEST_LOG_TABS.filter(t => t.view === 'rendered').map(t => t.id);
        assert.deepEqual(rendered, ['mdTrail']);
        assert.equal(QUEST_LOG_TABS.every(t => t.view === 'rendered' || t.view === 'source'), true);
    });

    test('ids are unique', () => {
        const ids = QUEST_LOG_TABS.map(t => t.id);
        assert.equal(new Set(ids).size, ids.length);
    });

    test('the default tab is MD Trail and is part of the catalogue', () => {
        assert.equal(DEFAULT_QUEST_LOG_TAB_ID, 'mdTrail');
        assert.equal(QUEST_LOG_TABS.some(t => t.id === DEFAULT_QUEST_LOG_TAB_ID), true);
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

    test('rejects unknown / non-string values', () => {
        assert.equal(isQuestLogTabId('logs'), false);
        assert.equal(isQuestLogTabId(''), false);
        assert.equal(isQuestLogTabId(undefined), false);
        assert.equal(isQuestLogTabId(null), false);
        assert.equal(isQuestLogTabId(7), false);
    });
});

describe('questLogFileName', () => {
    const cases: [QuestLogTabId, string][] = [
        ['mdTrail', 'live-trail.md'],
        ['trail', 'live-trail.md'],
        ['prompts', 'vscode_extension.anthropic.prompts.md'],
        ['answers', 'vscode_extension.anthropic.answers.md'],
        ['progress', 'progress.vscode_extension.md'],
        ['overview', 'overview.vscode_extension.md'],
        ['notes', 'quest-notes.vscode_extension.md'],
        ['refresh', 'quest_refresh.vscode_extension.md'],
        ['docUpdate', 'quest_documentation_update.vscode_extension.md'],
    ];

    for (const [id, expected] of cases) {
        test(`${id} → ${expected}`, () => {
            assert.equal(questLogFileName(id, 'vscode_extension'), expected);
        });
    }

    test('both trail tabs read the same file — one rendered, one as source', () => {
        assert.equal(
            questLogFileName('mdTrail', 'demo'),
            questLogFileName('trail', 'demo'),
        );
    });

    test('an empty quest id falls back to the "default" quest folder naming', () => {
        assert.equal(questLogFileName('progress', ''), 'progress.default.md');
    });

    test('a quest id with path separators cannot escape the quest folder', () => {
        // The separators are what make an id dangerous — `..` on its own is a
        // legal file-name component, so it survives; `/` does not.
        const name = questLogFileName('overview', '../../etc');
        assert.equal(name.includes('/'), false);
        assert.equal(name.includes('\\'), false);
        assert.equal(name, 'overview..._.._etc.md');
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
