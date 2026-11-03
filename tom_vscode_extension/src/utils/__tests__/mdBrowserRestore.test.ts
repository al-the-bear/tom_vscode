/**
 * MD Browser tabs across a window reload (src/utils/mdBrowserRestore.ts).
 *
 * VS Code brings a webview tab back after a reload but revives it only when it
 * is shown. Until then the tab exists and nothing knows its file, so the tools
 * could neither list nor close it (finishvse3). The extension remembers which
 * file each open tab shows and, at activation, registers the tabs that came
 * back as dormant panels with their file.
 *
 *   MRS-1 what is remembered: every live panel, plus the earlier records whose tab is still open and held
 *         by no live panel (a dormant tab, or the panels a shutdown disposed); a record whose tab was
 *         closed is dropped
 *   MRS-2 the restore plan: each open MD Browser tab no live panel holds is matched to a record by label
 *         and column (label alone when the column changed and the label is unique); its file there →
 *         dormant, its file gone → closed, no record → unknown
 *   MRS-3 the list is bounded
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_REMEMBERED_MD_PANELS, planDormantTabs, rememberedRecords, type MdPanelRecord } from '../mdBrowserRestore';

const rec = (label: string, viewColumn: number, filePath: string, liveMode = false): MdPanelRecord =>
    ({ label, viewColumn, filePath, liveMode });

describe('MD Browser tabs across a reload', () => {
    test('MRS-1: live panels and still-open dormant tabs are remembered, closed ones are not', () => {
        const live = [rec('MD: a.md', 1, '/w/a.md')];
        const previous = [
            rec('MD: a.md', 1, '/w/old-a.md'),    // the live panel holds that tab now
            rec('MD: b.md', 1, '/w/b.md'),        // dormant, still open
            rec('MD: c.md', 2, '/w/c.md'),        // its tab was closed
        ];
        const openTabs = [{ label: 'MD: a.md', viewColumn: 1 }, { label: 'MD: b.md', viewColumn: 1 }];
        assert.deepEqual(rememberedRecords(live, previous, openTabs), [
            rec('MD: a.md', 1, '/w/a.md'),
            rec('MD: b.md', 1, '/w/b.md'),
        ]);
    });

    test('MRS-1: a shutdown that disposed every panel keeps the records of the tabs still open', () => {
        const previous = [rec('MD: a.md', 1, '/w/a.md'), rec('MD (live): live-trail.md', 2, '/w/t/live-trail.md', true)];
        const openTabs = [{ label: 'MD: a.md', viewColumn: 1 }, { label: 'MD (live): live-trail.md', viewColumn: 2 }];
        assert.deepEqual(rememberedRecords([], previous, openTabs), previous);
    });

    test('MRS-2: dormant, gone and unknown tabs; tabs a live panel holds are left alone', () => {
        const records = [
            rec('MD: a.md', 1, '/w/a.md'),
            rec('MD: gone.md', 1, '/w/gone.md'),
            rec('MD (live): live-trail.md', 2, '/w/t/live-trail.md', true),
            rec('MD: shown.md', 1, '/w/shown.md'),
        ];
        const openTabs = [
            { label: 'MD: a.md', viewColumn: 1 },
            { label: 'MD: gone.md', viewColumn: 1 },
            { label: 'MD (live): live-trail.md', viewColumn: 3 },   // moved column: label alone decides
            { label: 'MD: shown.md', viewColumn: 1 },               // already revived
            { label: 'MD: mystery.md', viewColumn: 1 },             // from a build that remembered nothing
        ];
        const plan = planDormantTabs(openTabs, [{ label: 'MD: shown.md', viewColumn: 1 }], records, (p) => p !== '/w/gone.md');
        assert.deepEqual(plan.dormant.map((d) => [d.tab.label, d.tab.viewColumn, d.record.filePath, d.record.liveMode]), [
            ['MD: a.md', 1, '/w/a.md', false],
            ['MD (live): live-trail.md', 3, '/w/t/live-trail.md', true],
        ]);
        assert.deepEqual(plan.gone.map((g) => g.tab.label), ['MD: gone.md']);
        assert.deepEqual(plan.unknown.map((u) => u.label), ['MD: mystery.md']);
    });

    test('MRS-2: two tabs with one label in two columns each get their own record', () => {
        const records = [rec('MD: doc.md', 1, '/w/x/doc.md'), rec('MD: doc.md', 2, '/w/y/doc.md')];
        const openTabs = [{ label: 'MD: doc.md', viewColumn: 2 }, { label: 'MD: doc.md', viewColumn: 1 }];
        const plan = planDormantTabs(openTabs, [], records, () => true);
        assert.deepEqual(plan.dormant.map((d) => [d.tab.viewColumn, d.record.filePath]), [[2, '/w/y/doc.md'], [1, '/w/x/doc.md']]);
    });

    test('MRS-2: a moved tab whose label is not unique among the records is unknown, not guessed', () => {
        const records = [rec('MD: doc.md', 1, '/w/x/doc.md'), rec('MD: doc.md', 2, '/w/y/doc.md')];
        const plan = planDormantTabs([{ label: 'MD: doc.md', viewColumn: 3 }], [], records, () => true);
        assert.equal(plan.dormant.length, 0);
        assert.equal(plan.unknown.length, 1);
    });

    test('MRS-3: the remembered list is bounded', () => {
        const live = Array.from({ length: MAX_REMEMBERED_MD_PANELS + 5 }, (_, i) => rec(`MD: f${i}.md`, 1, `/w/f${i}.md`));
        assert.equal(rememberedRecords(live, [], []).length, MAX_REMEMBERED_MD_PANELS);
    });
});
