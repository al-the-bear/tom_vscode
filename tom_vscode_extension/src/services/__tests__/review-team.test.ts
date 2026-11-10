/**
 * The review team and the record of its rounds, as the MD Browser reads them (ccparity_f_teamreview-3;
 * src/services/review-team.ts, review-marks.ts decideAuthorChanges, som-review-comments.ts).
 *
 *   RT-1 decideAuthorChanges: every change one member made accepted or rejected, a shared mark included;
 *        votes are no authorship; another member's marks and comments stay; none: nothing decided
 *   RT-2 roundTeamFor: round.yaml beside the file (a copy) or above it (merged/): the team in order, the
 *        guests marked; no round file: null
 *   RT-3 a merged SOM document: its own team, and the revision entry the merge wrote with the round's team
 *        and its reviewers, a guest marked (readRevisionHistory, and the MD Browser's SOM reading)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { SomModelService } from '../som-model-service.js';
import { SomDocumentStore } from '../som-document-store.js';
import { decideAuthorChanges } from '../review-marks.js';
import { documentTeam, readRevisionHistory, roundTeamFor } from '../review-team.js';
import { somCommentContext } from '../som-review-comments.js';
import type { SpecToolDeps } from '../../tools/spec-tool-common.js';
import { specAddNodeImpl, specCreateDocumentImpl, specSetContentImpl } from '../../tools/spec-edit-tools.js';
import { specConvertImpl } from '../../tools/spec-validate-tools.js';
import { specMergeReviewsImpl, specReviewRoundCreateImpl } from '../../tools/spec-review-round-tools.js';
import { ROUND_FILE, stringifyRound } from '../../utils/reviewRound.js';

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-team-')));
const service = SomModelService.instance;
const deps: SpecToolDeps = { wsRoot: ws, store: new SomDocumentStore(service), service };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (impl: (d: SpecToolDeps, i: any) => Promise<string>, input: object): Promise<Json> => JSON.parse(await impl(deps, input));

describe('Review team and rounds', () => {
    test('RT-1: decide all of one member\'s changes', () => {
        const text = 'A {++ one ++}{@alice} B {~~ two ~> 2 ~~}{@alice,bob} C {-- three --}{@bob} D {++ four ++}{@carol +alice} {>> note <<}{@alice}';
        const accepted = decideAuthorChanges(text, 'alice', 'accept');
        assert.equal(accepted.decided, 2, 'her own change and the shared one; a vote is no authorship');
        assert.equal(accepted.text, 'A one B 2 C {-- three --}{@bob} D {++ four ++}{@carol +alice} {>> note <<}{@alice}');
        const rejected = decideAuthorChanges(text, 'bob', 'reject');
        assert.equal(rejected.decided, 2);
        assert.match(rejected.text, /B two C three D/);
        assert.deepEqual(decideAuthorChanges(text, 'dave', 'accept'), { text, decided: 0 });
    });

    test('RT-2: the round a file belongs to', () => {
        const folder = path.join(ws, 'round');
        fs.mkdirSync(path.join(folder, 'merged'), { recursive: true });
        fs.writeFileSync(path.join(folder, ROUND_FILE), stringifyRound({
            format: 1, document: 'doc.md', kind: 'markdown', base: 'base.md', extension: '.md', created: '', date: '2026-11-05', author: 'Alice',
            team: [{ memberId: 'alice', displayName: 'Alice', role: 'Owner' }, { memberId: 'bob', displayName: 'Bob', role: 'Dev' }],
            guests: [{ memberId: 'erin', displayName: 'Erin', role: 'Ops' }],
        }));
        const expected = [
            { memberId: 'alice', displayName: 'Alice', role: 'Owner' },
            { memberId: 'bob', displayName: 'Bob', role: 'Dev' },
            { memberId: 'erin', displayName: 'Erin', role: 'Ops', guest: true },
        ];
        assert.deepEqual(roundTeamFor(path.join(folder, 'alice.md'))?.members, expected, 'a member\'s copy');
        assert.deepEqual(roundTeamFor(path.join(folder, 'merged', 'doc.md'))?.members, expected, 'the merged document');
        assert.equal(roundTeamFor(path.join(ws, 'elsewhere', 'doc.md')), null);
    });

    test('RT-3: a merged SOM document\'s team and revision history', async () => {
        fs.mkdirSync(path.join(ws, 'som'), { recursive: true });
        const file = 'som/req.docspecs.yaml';
        assert.equal((await run(specCreateDocumentImpl, { file, root: 'RSP' })).ok, true);
        for (const [memberId, displayName, role, owner] of [['alice', 'Alice Owner', 'Product owner', true], ['bob', 'Bob Dev', 'Developer', false]] as const) {
            assert.equal((await run(specAddNodeImpl, { file, parentPath: 'RSP/reviewTeam', childSegment: 'RVMEM-MEMB-LST', fields: { content: { memberId, displayName, role, owner } } })).ok, true);
        }
        assert.equal((await run(specSetContentImpl, { file, path: 'RSP/content', text: 'Orders are kept two years.' })).ok, true);
        assert.equal((await run(specReviewRoundCreateImpl, { file, round: 'som/round', date: '2026-11-05' })).ok, true);
        assert.equal((await run(specSetContentImpl, { file: 'som/round/alice.docspecs.yaml', path: 'RSP/content', text: 'Orders are kept three years.' })).ok, true);
        fs.copyFileSync(path.join(ws, 'som/round/base.docspecs.yaml'), path.join(ws, 'som/round/erin.docspecs.yaml'));
        assert.equal((await run(specSetContentImpl, { file: 'som/round/erin.docspecs.yaml', path: 'RSP/content', text: 'Orders are kept two years, then archived.' })).ok, true);
        const merged = await run(specMergeReviewsImpl, { round: 'som/round', guests: [{ memberId: 'erin', displayName: 'Erin Ops', role: 'Operations' }] });
        assert.equal(merged.ok, true, JSON.stringify(merged));

        const loaded = deps.store.load(path.join(ws, 'som/round/merged/req.docspecs.yaml'));
        assert.deepEqual(documentTeam(loaded.document, 'RSP').map((m) => [m.memberId, m.owner]), [['alice', true], ['bob', false]]);
        const history = readRevisionHistory(service.model, loaded.document, 'RSP');
        assert.equal(history.length, 1);
        assert.equal(history[0].date, '2026-11-05');
        assert.equal(history[0].author, 'Alice Owner');
        assert.ok(history[0].version, 'the draft entry names the next version');
        assert.deepEqual(history[0].team.map((m) => m.memberId), ['alice', 'bob']);
        assert.deepEqual(history[0].reviewers.map((m) => [m.memberId, m.displayName, m.guest === true]), [['alice', 'Alice Owner', false], ['erin', 'Erin Ops', true]]);

        // The MD Browser reads the same from the document's Markdown rendition.
        assert.equal((await run(specConvertImpl, { file: 'som/round/merged/req.docspecs.yaml', target: 'som/round/merged/req.md', dropReview: true })).ok, true);
        const context = somCommentContext(deps.store.load(path.join(ws, 'som/round/merged/req.md')), service);
        assert.deepEqual(context.team.map((m) => m.memberId), ['alice', 'bob']);
        assert.deepEqual(context.revisions[0].reviewers.map((m) => [m.memberId, m.guest === true]), [['alice', false], ['erin', true]]);
    });
});
