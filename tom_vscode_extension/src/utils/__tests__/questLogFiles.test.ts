/**
 * Tests for the quest log-file catalogue that backs the @WS panel's Logs
 * section (eleven sub-tabs: MD Trail, Trail, Prompts, Answers, Progress,
 * Overview, Notes, Refresh, DocUpdate, Deferred, Current Prompt).
 *
 * The catalogue is pure — no `vscode`, no `fs` — so the sub-tab → file mapping,
 * the quest-id sanitisation and the tail window can be pinned down here rather
 * than by clicking through a webview. Four contracts matter most:
 *
 *   - **Every tab resolves to exactly one deterministic file.** The quest
 *     folder has no globbing: `progress.<quest>.md`, `<quest>.anthropic.
 *     prompts.md`, and the two trail tabs both point at `live-trail.md`.
 *   - **A tab names the *area* it reads from, not just a file name.** Ten tabs
 *     read the quest folder; Current Prompt reads the trail folder, which is
 *     gitignored — the whole point of putting a file rewritten on every send
 *     there rather than in the fleet-shared quest folder.
 *   - **The read window never splits a line.** The viewer reads only one slice
 *     of a multi-hundred-KB file; cutting mid-line would corrupt the first or
 *     last rendered line, so the slice is snapped to a newline at whichever end
 *     was cut.
 *   - **Each tab is read from the end its newest content is at.** The trail is
 *     appended to, so its slice is the file's tail; the quest documents are
 *     prepended to or rewritten wholesale, so theirs is the file's head.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    QUEST_LOG_TABS,
    CURRENT_PROMPT_VARIANTS,
    DEFAULT_QUEST_LOG_TAB_ID,
    DEFAULT_QUEST_LOG_VARIANT_ID,
    MAX_QUEST_LOG_BYTES,
    currentPromptFiles,
    isQuestLogTabId,
    isQuestLogVariantId,
    questLogLocation,
    questLogViewKey,
    computeTailStart,
    trimToLineStart,
    trimToLineEnd,
    type QuestLogTabId,
    type QuestLogVariantId,
} from '../questLogFiles.js';

describe('QUEST_LOG_TABS catalogue', () => {
    test('declares exactly the eleven sub-tabs, in order', () => {
        assert.deepEqual(
            QUEST_LOG_TABS.map(t => t.id),
            [
                'mdTrail', 'trail', 'prompts', 'answers', 'progress',
                'overview', 'notes', 'refresh', 'docUpdate', 'deferred',
                'currentPrompt',
            ],
        );
    });

    test('labels match the names the panel shows', () => {
        assert.deepEqual(
            QUEST_LOG_TABS.map(t => t.label),
            [
                'MD Trail', 'Trail', 'Prompts', 'Answers', 'Progress',
                'Overview', 'Notes', 'Refresh', 'DocUpdate', 'Deferred',
                'Current Prompt',
            ],
        );
    });

    test('only Current Prompt offers variants; every other tab is one file', () => {
        // `variants` is what makes the toolbar show a dropdown, so a stray
        // `true` here would put an inapplicable selector above a fixed file.
        const withVariants = QUEST_LOG_TABS.filter(t => t.variants).map(t => t.id);
        assert.deepEqual(withVariants, ['currentPrompt']);
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

    test('each tab is read from the end its own file grows at', () => {
        // live-trail.md is appended to, so its newest content is at the bottom,
        // and so is completion_steps.<quest>.md — deferred steps are added after
        // the ones already there. The remaining quest documents are prepended to
        // or rewritten wholesale, so reading their tail would show the oldest
        // content and open the view scrolled away from what the reader wants.
        // The current-prompt files are rewritten wholesale on every send, so
        // they too are read — and opened — at the top.
        const fromEnd = QUEST_LOG_TABS.filter(t => t.newestAt === 'end').map(t => t.id);
        assert.deepEqual(fromEnd, ['mdTrail', 'trail', 'deferred']);

        const fromStart = QUEST_LOG_TABS.filter(t => t.newestAt === 'start').map(t => t.id);
        assert.deepEqual(fromStart, [
            'prompts', 'answers', 'progress', 'overview',
            'notes', 'refresh', 'docUpdate', 'currentPrompt',
        ]);
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

describe('questLogLocation', () => {
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
        ['deferred', 'completion_steps.vscode_extension.md'],
    ];

    for (const [id, expected] of cases) {
        test(`${id} → quest folder / ${expected}`, () => {
            assert.deepEqual(
                questLogLocation(id, 'vscode_extension'),
                { area: 'quest', fileName: expected },
            );
        });
    }

    test('both trail tabs read the same file — one rendered, one as source', () => {
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

    test('Current Prompt reads the trail area, not the quest folder', () => {
        // This is the load-bearing half of the tab. The files are rewritten on
        // every single send; the quest folder is tracked in the fleet-shared
        // `_ai` repo, so parking them there would produce a merge conflict per
        // prompt on four machines. `_ai/trail/**` is gitignored — that is the
        // reason the area exists as a concept at all.
        assert.equal(questLogLocation('currentPrompt', 'demo', 'chatLiteral').area, 'trail');
    });

    test('each of the six variants maps to its own file', () => {
        const names = CURRENT_PROMPT_VARIANTS.map(
            v => questLogLocation('currentPrompt', 'demo', v.id).fileName,
        );
        assert.deepEqual(names, [
            'current_prompt.chat.literal.md',
            'current_prompt.chat.user.md',
            'current_prompt.chat.system.md',
            'current_prompt.queue.literal.md',
            'current_prompt.queue.user.md',
            'current_prompt.queue.system.md',
        ]);
        assert.equal(new Set(names).size, 6, 'two variants would overwrite each other');
    });

    test('the current-prompt file name does not carry the quest id', () => {
        // The quest is already the containing directory (one trail bucket per
        // quest). Repeating it in the name would only invite the two to
        // disagree.
        assert.equal(
            questLogLocation('currentPrompt', 'alpha', 'queueUser').fileName,
            questLogLocation('currentPrompt', 'beta', 'queueUser').fileName,
        );
    });

    test('a missing or bogus variant falls back to the default rather than throwing', () => {
        // The variant arrives from the webview, so it is boundary input: an old
        // persisted selection or a plain `qlogRequest` without one must still
        // resolve to a readable file.
        const expected = questLogLocation('currentPrompt', 'demo', DEFAULT_QUEST_LOG_VARIANT_ID);
        assert.deepEqual(questLogLocation('currentPrompt', 'demo'), expected);
        assert.deepEqual(
            questLogLocation('currentPrompt', 'demo', 'nonsense' as QuestLogVariantId),
            expected,
        );
    });

    test('a variant passed for a non-variant tab is ignored', () => {
        assert.deepEqual(
            questLogLocation('progress', 'demo', 'queueSystem'),
            questLogLocation('progress', 'demo'),
        );
    });
});

/**
 * The dropdown the Current Prompt tab carries. The user asked for the three
 * parts of a dispatched prompt — what they typed, what was actually sent as the
 * user message, and the system prompt — for each of the two prompts that can be
 * in flight at once, since a queue item and a chat message run in parallel.
 */
describe('CURRENT_PROMPT_VARIANTS', () => {
    test('is the full product of two origins and three parts, in order', () => {
        assert.deepEqual(
            CURRENT_PROMPT_VARIANTS.map(v => v.id),
            ['chatLiteral', 'chatUser', 'chatSystem', 'queueLiteral', 'queueUser', 'queueSystem'],
        );
    });

    test('labels are the three names prefixed by the origin', () => {
        assert.deepEqual(
            CURRENT_PROMPT_VARIANTS.map(v => v.label),
            [
                'Chat Literal Prompt', 'Chat User Prompt', 'Chat System Prompt',
                'Queue Literal Prompt', 'Queue User Prompt', 'Queue System Prompt',
            ],
        );
    });

    test('every variant carries the origin and part it was built from', () => {
        for (const v of CURRENT_PROMPT_VARIANTS) {
            assert.ok(v.source === 'chat' || v.source === 'queue', `${v.id} has no origin`);
            assert.ok(
                v.part === 'literal' || v.part === 'user' || v.part === 'system',
                `${v.id} has no part`,
            );
            assert.ok(v.label.startsWith(v.source === 'chat' ? 'Chat ' : 'Queue '));
        }
    });

    test('the origins match the PromptSource values the send path already threads through', () => {
        // `source` is handed straight to the capture writer, which is keyed by
        // the same `PromptSource` union the Anthropic handler resolves from
        // `options.source ?? 'chat'`. A third spelling here would write files
        // nobody reads.
        assert.deepEqual([...new Set(CURRENT_PROMPT_VARIANTS.map(v => v.source))], ['chat', 'queue']);
    });

    test('the default selection is the chat prompt the user typed', () => {
        assert.equal(DEFAULT_QUEST_LOG_VARIANT_ID, 'chatLiteral');
        assert.equal(CURRENT_PROMPT_VARIANTS.some(v => v.id === DEFAULT_QUEST_LOG_VARIANT_ID), true);
    });
});

describe('isQuestLogVariantId', () => {
    test('accepts every catalogued variant', () => {
        for (const v of CURRENT_PROMPT_VARIANTS) {
            assert.equal(isQuestLogVariantId(v.id), true);
        }
    });

    test('rejects unknown / non-string values', () => {
        assert.equal(isQuestLogVariantId('literal'), false);
        assert.equal(isQuestLogVariantId('chat'), false);
        assert.equal(isQuestLogVariantId(''), false);
        assert.equal(isQuestLogVariantId(undefined), false);
        assert.equal(isQuestLogVariantId(null), false);
        assert.equal(isQuestLogVariantId(3), false);
    });
});

/**
 * The host caches what it last sent so an unchanged file costs one `stat`.
 * Before the dropdown existed the cache key could be the tab id, because a tab
 * meant a file. It no longer does — six variants share one tab — so the key has
 * to name what is actually on screen.
 */
describe('questLogViewKey', () => {
    test('distinguishes the six variants of the one tab', () => {
        const keys = CURRENT_PROMPT_VARIANTS.map(v => questLogViewKey('currentPrompt', v.id));
        assert.equal(new Set(keys).size, 6);
    });

    test('a variantless tab has one key however it is asked for', () => {
        assert.equal(questLogViewKey('progress'), questLogViewKey('progress', 'queueUser'));
    });

    test('different tabs never share a key', () => {
        const keys = QUEST_LOG_TABS.map(t => questLogViewKey(t.id));
        assert.equal(new Set(keys).size, QUEST_LOG_TABS.length);
    });
});

/**
 * The writer side of the same mapping. It lives next to the reader's so the two
 * cannot disagree about a file name — a mismatch would not fail anywhere, it
 * would just show an empty tab forever.
 */
describe('currentPromptFiles', () => {
    const texts = { literal: 'what I typed', user: 'expanded user message', system: 'you are…' };

    test('produces one file per part of the given origin', () => {
        assert.deepEqual(currentPromptFiles('queue', texts), [
            { fileName: 'current_prompt.queue.literal.md', text: 'what I typed' },
            { fileName: 'current_prompt.queue.user.md', text: 'expanded user message' },
            { fileName: 'current_prompt.queue.system.md', text: 'you are…' },
        ]);
    });

    test('writes the chat and queue sets to different files', () => {
        const chat = currentPromptFiles('chat', texts).map(f => f.fileName);
        const queue = currentPromptFiles('queue', texts).map(f => f.fileName);
        assert.equal(chat.some(name => queue.includes(name)), false);
    });

    test('every file the reader can select is written on every send', () => {
        // The tab is "what is running *now*". Skipping a part would leave the
        // previous send's text in place and present it as current — the one
        // failure mode that looks like working software.
        const written = new Set([
            ...currentPromptFiles('chat', texts),
            ...currentPromptFiles('queue', texts),
        ].map(f => f.fileName));
        for (const variant of CURRENT_PROMPT_VARIANTS) {
            const { fileName } = questLogLocation('currentPrompt', 'demo', variant.id);
            assert.ok(written.has(fileName), `nothing writes ${fileName} (variant ${variant.id})`);
        }
    });

    test('an absent system prompt is written as an empty file, not skipped', () => {
        // The user's requirement, verbatim: with no system prompt the tab
        // "would remain empty". Skipping the write would instead show whatever
        // the last profile that *did* have one left behind.
        const files = currentPromptFiles('chat', { literal: 'hi', user: 'hi', system: '' });
        assert.equal(files.length, 3);
        assert.deepEqual(files[2], { fileName: 'current_prompt.chat.system.md', text: '' });
    });

    test('undefined texts are normalised to empty rather than the string "undefined"', () => {
        const files = currentPromptFiles('chat', {
            literal: undefined as unknown as string,
            user: undefined as unknown as string,
            system: undefined as unknown as string,
        });
        assert.deepEqual(files.map(f => f.text), ['', '', '']);
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
