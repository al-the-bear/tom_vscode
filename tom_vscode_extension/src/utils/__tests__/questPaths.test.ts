/**
 * Tests for the shared quest-id → path-segment normalisation.
 *
 * Four subsystems derive a path from a quest id — the live-trail writer, the
 * extension-config store, the chat panel's trail opener, and the @WS Logs
 * viewer. They read and write each other's files, so any disagreement about
 * how an id becomes a folder name shows up as a silently empty view rather
 * than an error. These tests pin the single rule they all share.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import { QUEST_TRAIL_SUBFOLDER, questTrailFolder, sanitizeQuestSegment } from '../questPaths.js';

describe('sanitizeQuestSegment', () => {
    test('keeps letters, digits, underscore, dot and dash', () => {
        assert.equal(sanitizeQuestSegment('vscode_extension-2.0'), 'vscode_extension-2.0');
    });

    test('replaces every other character with an underscore', () => {
        assert.equal(sanitizeQuestSegment('a/b\\c d'), 'a_b_c_d');
    });

    test('strips the separators that would let an id escape the quest folder', () => {
        const seg = sanitizeQuestSegment('../../etc/passwd');
        assert.equal(seg.includes('/'), false);
        assert.equal(seg.includes('\\'), false);
    });

    test('falls back to "default" for an empty or missing id', () => {
        assert.equal(sanitizeQuestSegment(''), 'default');
        assert.equal(sanitizeQuestSegment(undefined), 'default');
        assert.equal(sanitizeQuestSegment(null), 'default');
    });
});

describe('questTrailFolder', () => {
    test('is the quest folder\'s history subfolder', () => {
        assert.equal(
            questTrailFolder(path.join('/ws', '_ai', 'quests', 'demo')),
            path.join('/ws', '_ai', 'quests', 'demo', 'history'),
        );
    });

    test('names the subfolder through the shared constant', () => {
        // Writers resolve the folder from the config pattern and readers from
        // this helper, so the segment they agree on has to have one spelling.
        assert.equal(QUEST_TRAIL_SUBFOLDER, 'history');
        assert.equal(
            path.basename(questTrailFolder('/ws/_ai/quests/demo')),
            QUEST_TRAIL_SUBFOLDER,
        );
    });

    test('returns an empty string for an unresolved quest folder', () => {
        // Callers that could not resolve a workspace root pass '' along; joining
        // it would produce a bare relative 'history' pointing at the cwd.
        assert.equal(questTrailFolder(''), '');
    });
});
