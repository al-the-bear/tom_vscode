/**
 * Tests for the pure completion-service discovery + ranking logic.
 *
 * Coverage:
 *   - discoverSkills walks parents, marks direct vs note, prefix-filters,
 *     closest-wins on name collisions, sorts direct-first then alpha
 *   - formatSkillInsertion renders `/name` and `/name (in dir)`
 *   - rankFiles tiers open-editors → quest-folder → other, de-dups,
 *     substring-filters, sorts by basename within tier
 *   - formatFileInsertion renders `@name (relpath)`
 *   - detectToken finds `/` and `@` tokens, respects whitespace boundary
 *
 * No `vscode` import — the service is pure, so no stub is needed.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import {
    discoverSkills,
    formatSkillInsertion,
    rankFiles,
    formatFileInsertion,
    detectToken,
    type SkillStore,
} from '../completion-service.js';

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

describe('completion-service.discoverSkills', () => {
    // A fake hierarchy:
    //   /a/b/c/ws          (workspace root)  → skills: alpha, beta
    //   /a/b               (grandparent)     → skills: tom_reconcile
    //   /a                 (great-grandparent)→ skills: alpha (masked), gamma
    const wsRoot = path.join('/a', 'b', 'c', 'ws');
    const skillsAt: Record<string, string[]> = {
        [path.join(wsRoot, '.claude', 'skills')]: ['alpha', 'beta'],
        [path.join('/a', 'b', '.claude', 'skills')]: ['tom_reconcile'],
        [path.join('/a', '.claude', 'skills')]: ['alpha', 'gamma'],
    };
    const store: SkillStore = {
        wsRoot: () => wsRoot,
        listSkillFolders: (dir) => skillsAt[dir] ?? [],
    };

    test('returns all skills when query is empty, direct first then alpha', () => {
        const out = discoverSkills(store, '');
        assert.deepEqual(out.map((s) => s.name), ['alpha', 'beta', 'gamma', 'tom_reconcile']);
        // alpha + beta are direct (workspace-own), gamma + tom_reconcile are not.
        assert.equal(out[0].direct, true);
        assert.equal(out[1].direct, true);
        assert.equal(out[2].direct, false);
        assert.equal(out[3].direct, false);
    });

    test('workspace-own skill masks a same-named ancestor (closest wins)', () => {
        const out = discoverSkills(store, 'alpha');
        assert.equal(out.length, 1);
        assert.equal(out[0].direct, true);
        assert.equal(out[0].noteDir, null);
    });

    test('non-direct skills carry a workspace-relative note dir', () => {
        const out = discoverSkills(store, 'tom');
        assert.equal(out.length, 1);
        assert.equal(out[0].name, 'tom_reconcile');
        assert.equal(out[0].direct, false);
        // /a/b/.claude/skills relative to /a/b/c/ws → ../../.claude/skills
        assert.equal(out[0].noteDir, path.join('..', '..', '.claude', 'skills'));
    });

    test('prefix filter is case-insensitive', () => {
        assert.equal(discoverSkills(store, 'BET').length, 1);
        assert.equal(discoverSkills(store, 'zzz').length, 0);
    });

    test('returns empty when no workspace is open', () => {
        const noWs: SkillStore = { wsRoot: () => null, listSkillFolders: () => [] };
        assert.deepEqual(discoverSkills(noWs, ''), []);
    });
});

describe('completion-service.formatSkillInsertion', () => {
    test('direct skill renders bare /name', () => {
        assert.equal(
            formatSkillInsertion({ name: 'foo', skillsDir: '/x', direct: true, noteDir: null }),
            '/foo',
        );
    });
    test('non-direct skill renders /name (in dir)', () => {
        assert.equal(
            formatSkillInsertion({ name: 'foo', skillsDir: '/x', direct: false, noteDir: '../.claude/skills' }),
            '/foo (in ../.claude/skills)',
        );
    });
});

// ---------------------------------------------------------------------------
// rankFiles
// ---------------------------------------------------------------------------

describe('completion-service.rankFiles', () => {
    const wsRoot = path.join('/ws');
    const quest = path.join(wsRoot, '_ai', 'quests', 'demo');
    const f = (...segs: string[]) => path.join(wsRoot, ...segs);

    const allFiles = [
        f('src', 'index.ts'),
        f('src', 'live-helper.ts'),
        f('_ai', 'quests', 'demo', 'live-trail.md'),
        f('_ai', 'quests', 'demo', 'overview.demo.md'),
        f('README.md'),
    ];
    const openEditors = [f('src', 'index.ts')];

    test('open editors rank above quest-folder above other', () => {
        const out = rankFiles({ wsRoot, questFolder: quest, openEditors, allFiles, query: '' });
        assert.equal(out[0].relativePath, 'src/index.ts');      // tier 1 (open)
        assert.equal(out[0].tier, 1);
        // tier 2 = quest-folder files, sorted by basename
        const tier2 = out.filter((c) => c.tier === 2).map((c) => c.relativePath);
        assert.deepEqual(tier2, [
            '_ai/quests/demo/live-trail.md',
            '_ai/quests/demo/overview.demo.md',
        ]);
        // Sorted by basename via localeCompare: `live-helper.ts` < `README.md`.
        const tier3 = out.filter((c) => c.tier === 3).map((c) => c.relativePath);
        assert.deepEqual(tier3, ['src/live-helper.ts', 'README.md']);
    });

    test('substring filter is case-insensitive and matches basenames', () => {
        const out = rankFiles({ wsRoot, questFolder: quest, openEditors, allFiles, query: 'LIVE' });
        assert.deepEqual(
            out.map((c) => c.relativePath).sort(),
            ['_ai/quests/demo/live-trail.md', 'src/live-helper.ts'],
        );
    });

    test('de-dups a file that is both open and in allFiles', () => {
        const out = rankFiles({
            wsRoot, questFolder: quest,
            openEditors: [f('src', 'index.ts')],
            allFiles: [f('src', 'index.ts')],
            query: 'index',
        });
        assert.equal(out.length, 1);
        assert.equal(out[0].tier, 1);
    });

    test('relative paths use POSIX separators', () => {
        const out = rankFiles({ wsRoot, questFolder: null, openEditors: [], allFiles: [f('a', 'b', 'c.ts')], query: '' });
        assert.equal(out[0].relativePath, 'a/b/c.ts');
    });
});

describe('completion-service.formatFileInsertion', () => {
    test('renders @name (relpath)', () => {
        assert.equal(
            formatFileInsertion({ absolutePath: '/ws/a/b.md', name: 'b.md', relativePath: 'a/b.md', tier: 3 }),
            '@b.md (a/b.md)',
        );
    });
});

// ---------------------------------------------------------------------------
// detectToken
// ---------------------------------------------------------------------------

describe('completion-service.detectToken', () => {
    test('detects a skill token at end of text', () => {
        const t = detectToken('hello /tom', 10);
        assert.equal(t?.kind, 'skill');
        assert.equal(t?.query, 'tom');
        assert.equal(t?.start, 6);
        assert.equal(t?.end, 10);
    });

    test('detects a file token after whitespace', () => {
        const t = detectToken('see @live', 9);
        assert.equal(t?.kind, 'file');
        assert.equal(t?.query, 'live');
    });

    test('trigger at start of text is valid', () => {
        const t = detectToken('/all', 4);
        assert.equal(t?.kind, 'skill');
        assert.equal(t?.query, 'all');
    });

    test('bare trigger with empty query is valid', () => {
        const t = detectToken('go /', 4);
        assert.equal(t?.kind, 'skill');
        assert.equal(t?.query, '');
    });

    test('does not trigger mid-word (no whitespace before trigger)', () => {
        assert.equal(detectToken('path/to', 7), null);     // `/` preceded by `h`
        assert.equal(detectToken('user@host', 9), null);   // `@` preceded by `r`
    });

    test('whitespace between trigger and cursor aborts', () => {
        assert.equal(detectToken('/tom now', 8), null);
    });

    test('no trigger returns null', () => {
        assert.equal(detectToken('plain text', 10), null);
    });
});
