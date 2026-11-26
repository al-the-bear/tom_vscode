/**
 * Format version 11, steps `notes`, `memory` and `qa-journal` (src/utils/formatV11/notesMemoryQa.ts): the quest
 * notes into `notes/`, the quest memory into the quest folder, the old questions and decisions journals into this
 * host's Q&A journal (ai_format_migration.md § 3.2).
 *
 *   NM-1 a dry run lists every move, merge and deletion of the three steps and writes nothing
 *   NM-2 the run: `quest-notes.<q>.md` -> `notes/quest-notes.md`; the default session's memory files (flat,
 *        `default`, `default@default`) become the curated files; every other session's facts become this host's
 *        candidates, one per fact, naming their session and the curated file, a stamped fact keeping its stamp and
 *        an unstamped one taking the file's time and this host; the old history snapshots move to `history/`;
 *        `_ai/memory/` goes; the old journals become question / answer / decision blocks and go
 *   NM-3 a second run lists nothing and changes nothing
 *   NM-4 merging into existing targets: the notes appended under their heading (or only the old file removed when
 *        the target holds its text); a curated file gets the lines and sections it lacks, nothing twice; this
 *        host's candidates file keeps its entries; this host's file under the machine's host name merges in; the
 *        journal's own blocks keep their text and the old entries go between them by time
 *   NM-5 the old journals with odd content: Markdown headings and fenced code in questions, answers and decision
 *        details; a numbered line inside fenced code is no new question; an empty journal (only its header)
 *   NM-6 the problems: a memory file that is no `.md`, a history snapshot whose target differs, an old journal no
 *        entry of which can be read, a candidates file with foreign lines — each left where it is
 *   NM-7 through migrateAiFormats (format version 11): the older storage step's move of flat memory files and this
 *        step's merge into the quest folder end in the same layout; the stamp is written
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { migrateAiFormats } from '../aiFormatMigration';
import type { V11Context, V11Step } from '../formatV11/context';
import {
    mergeCuratedMemory, migrateV11NotesMemoryQaWith, oldNotesHeading, parseOldQuestionsJournal,
} from '../formatV11/notesMemoryQa';
import { combineQaBlocks, parseQaJournal } from '../qaJournal';

interface Entry { quest: string; step: V11Step; detail: string }

const HOST = 'mbp';
/** The machine's host name in these tests (the name of this host's candidates file before the host slug). */
const HOST_NAME = 'MBP.local';

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-notes-memory-qa-'));
    const ai = path.join(root, '_ai');
    fs.mkdirSync(path.join(ai, 'quests'), { recursive: true });
    const write = (rel: string, text: string, mtimeSeconds?: number): string => {
        const p = path.join(ai, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
        if (mtimeSeconds !== undefined) { fs.utimesSync(p, mtimeSeconds, mtimeSeconds); }
        return p;
    };
    const exists = (rel: string): boolean => fs.existsSync(path.join(ai, rel));
    const read = (rel: string): string => fs.readFileSync(path.join(ai, rel), 'utf8');
    const tree = (): string[] => {
        const out: string[] = [];
        const walk = (dir: string): void => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) { walk(p); } else { out.push(`${path.relative(ai, p).split(path.sep).join('/')}=${fs.readFileSync(p, 'utf8')}`); }
            }
        };
        walk(ai);
        return out.sort();
    };
    const step = (apply: boolean): { changes: Entry[]; problems: Entry[] } => {
        const changes: Entry[] = [];
        const problems: Entry[] = [];
        const quests = fs.readdirSync(path.join(ai, 'quests')).sort();
        const ctx: V11Context = {
            aiRoot: ai, hostSlug: HOST, apply, quests, allQuests: quests,
            change: (quest, s, detail) => changes.push({ quest, step: s, detail }),
            problem: (quest, s, detail) => problems.push({ quest, step: s, detail }),
            rel: (p) => path.relative(ai, p).split(path.sep).join('/'),
        };
        migrateV11NotesMemoryQaWith(ctx, HOST_NAME);
        return { changes, problems };
    };
    return { root, ai, write, exists, read, tree, step };
}

const OLD_QUESTIONS = [
    '# Questions — qa',
    '',
    'Every question the ask-the-user tools put to you, with the answer that',
    'came back.',
    'Appended to: the newest entry is at the bottom.',
    '## 2026-08-03T12:22:07.000Z — Migration plan',
    '',
    '- **Tool:** `tomAi_askUser`',
    '- **Run:** collab',
    '- **Answered:** 2026-08-03T12:24:31.000Z via vscode, after 2m 24s',
    '',
    '### Questions',
    '',
    '1. Which database should I target?',
    '2. A question with code:',
    '```text',
    '## 2026-01-01T00:00:00.000Z — not an entry',
    '3. not a question',
    '### Answer',
    '```',
    '',
    '### Answer',
    '',
    '> Postgres, and no.',
    '> ## not a heading',
    '>',
    '> ```',
    '> code',
    '> ```',
    '',
    '## 2026-08-04T08:00:00.000Z — tomAi_askUserPicker',
    '',
    '- **Tool:** `tomAi_askUserPicker`',
    '- **Run:** default',
    '- **Answered:** 2026-08-04T08:01:00.000Z via timeout, after 1m 0s',
    '',
    '### Answer',
    '',
    '> _(no answer text)_',
    '',
].join('\n');

const OLD_DECISIONS = [
    '# Decisions — qa',
    '',
    'What was decided on the todos of this quest.',
    'Appended to: the newest entry is at the bottom.',
    '## 2026-08-02T09:00:00.000Z — `qa1_x-first` — QA1: the first decision',
    '',
    '1. **Which way?**',
    '   - **Needed:** (a) left, (b) right.',
    '     ```',
    '     ## 2026-01-01T00:00:00.000Z — inside fenced code',
    '     ```',
    '   - **Decided:** (a)',
    '## 2026-08-05T10:00:00.000Z — Reset Run: run r1',
    '',
    '- **Was:** p › a',
    '',
].join('\n');

/** A quest `qa` with every old file kind of the three steps, and files that stay. */
function oldQuest(s: ReturnType<typeof sandbox>): void {
    s.write('quests/qa/quest-notes.qa.md', '# Quest Notes — qa\n\nmy notes\n');
    s.write('quests/qa/overview.qa.md', 'overview\n');
    s.write('memory/qa/facts.md', '- 2026-06-01T00:00:00.000Z [old] a flat fact\n');
    s.write('memory/qa/default@default/facts.md', '- 2026-06-02T00:00:00.000Z [old] a default fact\n\n## Rules\n\nrule one\n');
    s.write('memory/qa/default@default/flutter.md', 'flutter notes\n');
    s.write('memory/qa/chat/facts.md', [
        '# Memory',
        '- 2026-06-03T00:00:00.000Z [Old-Host.local] a stamped chat fact',
        '- an unstamped chat fact',
        '',
        '## Night mode',
        '',
        'The user is away.',
        'Do not ask.',
        '',
        '- a bullet in the section',
        '',
    ].join('\n'), 1_700_000_000);
    s.write('memory/qa/work@r1/topic.md', 'one line fact\n', 1_700_000_100);
    s.write('memory/qa/history/20260416_074427.history.json', '{"messages":[]}\n');
    s.write('quests/qa/questions.qa.md', OLD_QUESTIONS);
    s.write('quests/qa/decisions.qa.md', OLD_DECISIONS);
}

const OWN_CANDIDATES = `quests/qa/memory/candidates.${HOST}.md`;

describe('format version 11: notes, memory, Q&A journal', () => {
    test('NM-1: a dry run lists everything and writes nothing', () => {
        const s = sandbox();
        oldQuest(s);
        const before = s.tree();
        const r = s.step(false);
        assert.deepEqual(r.problems, []);
        const details = r.changes.map((c) => `${c.step}: ${c.detail}`);
        assert.deepEqual(details, [
            'notes: move quests/qa/quest-notes.qa.md -> quests/qa/notes/quest-notes.md',
            'memory: 4 facts of memory/qa/chat/facts.md -> candidates in quests/qa/memory/candidates.mbp.md (session chat)',
            'memory: move memory/qa/default@default/facts.md -> quests/qa/memory/facts.md',
            'memory: move memory/qa/default@default/flutter.md -> quests/qa/memory/flutter.md',
            'memory: merge memory/qa/facts.md into quests/qa/memory/facts.md (1 entry added)',
            'memory: move memory/qa/history/20260416_074427.history.json -> quests/qa/history/20260416_074427.history.json',
            'memory: 1 fact of memory/qa/work@r1/topic.md -> candidates in quests/qa/memory/candidates.mbp.md (session work@r1)',
            'memory: remove memory/qa',
            'qa-journal: 2 questions of quests/qa/questions.qa.md -> quests/qa/qa.mbp.qa.md, then remove it',
            'qa-journal: 2 decisions of quests/qa/decisions.qa.md -> quests/qa/qa.mbp.qa.md, then remove it',
        ]);
        assert.ok(r.changes.every((c) => c.quest === 'qa'));
        assert.deepEqual(s.tree(), before, 'nothing written');
    });

    test('NM-2 and NM-3: the run, then a second run', () => {
        const s = sandbox();
        oldQuest(s);
        const r = s.step(true);
        assert.deepEqual(r.problems, []);

        // Notes.
        assert.equal(s.read('quests/qa/notes/quest-notes.md'), '# Quest Notes — qa\n\nmy notes\n');
        assert.equal(s.exists('quests/qa/quest-notes.qa.md'), false);
        assert.equal(s.read('quests/qa/overview.qa.md'), 'overview\n', 'other files stay');

        // Curated memory: the default session's files and the flat ones, merged.
        assert.equal(s.read('quests/qa/memory/facts.md'),
            '- 2026-06-02T00:00:00.000Z [old] a default fact\n- 2026-06-01T00:00:00.000Z [old] a flat fact\n\n## Rules\n\nrule one\n');
        assert.equal(s.read('quests/qa/memory/flutter.md'), 'flutter notes\n');

        // Candidates: one per fact, newest first; a stamp kept, the file's time and this host otherwise.
        const chatTime = new Date(1_700_000_000_000).toISOString();
        const workTime = new Date(1_700_000_100_000).toISOString();
        assert.equal(s.read(OWN_CANDIDATES), [
            '- 2026-06-03T00:00:00.000Z [Old-Host.local] {session=chat file=facts.md} a stamped chat fact',
            `- ${workTime} [mbp] {session=work@r1 file=topic.md} one line fact`,
            `- ${chatTime} [mbp] {session=chat file=facts.md} an unstamped chat fact`,
            `- ${chatTime} [mbp] {session=chat file=facts.md} Night mode — The user is away. Do not ask.`,
            `- ${chatTime} [mbp] {session=chat file=facts.md} Night mode — a bullet in the section`,
            '',
        ].join('\n'));

        // The old history snapshots; `_ai/memory/` is gone.
        assert.equal(s.read('quests/qa/history/20260416_074427.history.json'), '{"messages":[]}\n');
        assert.equal(s.exists('memory'), false);

        // The Q&A journal.
        assert.equal(s.exists('quests/qa/questions.qa.md'), false);
        assert.equal(s.exists('quests/qa/decisions.qa.md'), false);
        const journal = s.read('quests/qa/qa.mbp.qa.md');
        assert.ok(journal.startsWith('# Q&A — qa (mbp)\n'));
        const blocks = parseQaJournal(journal);
        assert.deepEqual(blocks.map((b) => [b.kind, b.time]), [
            ['decision', '2026-08-02T09:00:00.000Z'],
            ['question', '2026-08-03T12:22:07.000Z'],
            ['answer', '2026-08-03T12:24:31.000Z'],
            ['question', '2026-08-04T08:00:00.000Z'],
            ['answer', '2026-08-04T08:01:00.000Z'],
            ['decision', '2026-08-05T10:00:00.000Z'],
        ], 'in time order');
        assert.ok(blocks.every((b) => b.host === 'mbp'));
        const items = combineQaBlocks(blocks);
        const plan = items.find((i) => i.title === 'Migration plan')!;
        assert.equal(plan.tool, 'tomAi_askUser');
        assert.equal(plan.run, 'collab');
        assert.deepEqual(plan.reply && [plan.reply.text, plan.reply.source], ['Postgres, and no.\n## not a heading\n\n```\ncode\n```', 'vscode']);
        const picker = items.find((i) => i.tool === 'tomAi_askUserPicker')!;
        assert.equal(picker.title, undefined, 'a heading that only named the tool is no title');
        assert.deepEqual(picker.reply && [picker.reply.text, picker.reply.source], ['', 'timeout']);
        const decision = items.find((i) => i.kind === 'decision' && i.title?.includes('QA1'))!;
        assert.equal(decision.title, '`qa1_x-first` — QA1: the first decision');
        assert.match(decision.details!, /^1\. \*\*Which way\?\*\*\n[\s\S]*inside fenced code[\s\S]*\*\*Decided:\*\* \(a\)$/);

        // NM-3: a second run.
        const after = s.tree();
        const again = s.step(true);
        assert.deepEqual([again.changes, again.problems], [[], []]);
        assert.deepEqual(s.tree(), after);
    });

    test('NM-4: merging into existing targets', () => {
        const s = sandbox();
        // Notes: a target with other content; another quest whose target holds the old text already.
        s.write('quests/qa/quest-notes.qa.md', 'old notes\n');
        s.write('quests/qa/notes/quest-notes.md', '# Quest Notes — qa\n\nnew notes\n');
        s.write('quests/qb/quest-notes.qb.md', 'same text\n');
        s.write('quests/qb/notes/quest-notes.md', '# Notes\n\nsame text\n');
        // Memory: curated files and candidates already in the quest folder.
        s.write('quests/qa/memory/facts.md', '- 2026-06-02T00:00:00.000Z [old] a default fact\n\n## Rules\n\nrule one\n');
        s.write('memory/qa/default@default/facts.md', [
            '- 2026-06-02T00:00:00.000Z [old] a default fact',
            '- 2026-06-04T00:00:00.000Z [old] a new default fact',
            '',
            '## Rules',
            '',
            'rule one',
            'rule two',
            '',
            '## Tools',
            '',
            'use the tools',
            '',
        ].join('\n'));
        s.write(OWN_CANDIDATES, '- 2026-07-01T00:00:00.000Z [mbp] {session=x file=facts.md} already a candidate\n');
        s.write(`quests/qa/memory/candidates.${HOST_NAME}.md`, '- 2026-05-01T00:00:00.000Z [MBP.local] {session=y file=facts.md} under the host name\n');
        s.write('quests/qa/memory/candidates.bomber.md', '- 2026-05-02T00:00:00.000Z [bomber] {session=z file=facts.md} another host\n');
        s.write('memory/qa/walk/facts.md', '- 2026-06-05T00:00:00.000Z [old] a walk fact\n');
        // The journal: blocks of its own, before and after the old entries.
        const own = [
            '# Q&A — qa (mbp)',
            '',
            'preamble',
            '',
            '<!-- qa {"id":"g-early","kind":"answerGiven","time":"2026-08-01T00:00:00.000Z","host":"mbp","title":"Early"} -->',
            '### written by hand: kept as it is',
            '',
            '#### Answer',
            '',
            '> early',
            '',
            '<!-- qa {"id":"g-late","kind":"answerGiven","time":"2026-12-01T00:00:00.000Z","host":"mbp","title":"Late"} -->',
            '### 2026-12-01T00:00:00.000Z · Answer given: Late',
            '',
            '#### Answer',
            '',
            '> late',
            '',
        ].join('\n');
        s.write('quests/qa/qa.mbp.qa.md', own);
        s.write('quests/qa/questions.qa.md', OLD_QUESTIONS);

        const dry = s.step(false);
        assert.ok(dry.changes.some((c) => c.detail === `append quests/qa/quest-notes.qa.md to quests/qa/notes/quest-notes.md under "${oldNotesHeading('qa')}", then remove it`));
        assert.ok(dry.changes.some((c) => c.quest === 'qb' && c.detail === 'remove quests/qb/quest-notes.qb.md (quests/qb/notes/quest-notes.md holds its text)'));
        assert.ok(dry.changes.some((c) => c.detail === 'merge memory/qa/default@default/facts.md into quests/qa/memory/facts.md (3 entries added)'));
        assert.ok(dry.changes.some((c) => c.detail === `merge quests/qa/memory/candidates.${HOST_NAME}.md into ${OWN_CANDIDATES}, then remove it`));
        s.step(true);

        assert.equal(s.read('quests/qa/notes/quest-notes.md'), `# Quest Notes — qa\n\nnew notes\n\n${oldNotesHeading('qa')}\n\nold notes\n`);
        assert.equal(s.exists('quests/qa/quest-notes.qa.md'), false);
        assert.equal(s.read('quests/qb/notes/quest-notes.md'), '# Notes\n\nsame text\n');
        assert.equal(s.exists('quests/qb/quest-notes.qb.md'), false);

        assert.equal(s.read('quests/qa/memory/facts.md'), [
            '- 2026-06-02T00:00:00.000Z [old] a default fact',
            '- 2026-06-04T00:00:00.000Z [old] a new default fact',
            '',
            '## Rules',
            '',
            'rule one',
            '',
            'rule two',
            '',
            '## Tools',
            '',
            'use the tools',
            '',
        ].join('\n'));
        assert.equal(s.read(OWN_CANDIDATES), [
            '- 2026-07-01T00:00:00.000Z [mbp] {session=x file=facts.md} already a candidate',
            '- 2026-06-05T00:00:00.000Z [old] {session=walk file=facts.md} a walk fact',
            '- 2026-05-01T00:00:00.000Z [MBP.local] {session=y file=facts.md} under the host name',
            '',
        ].join('\n'));
        assert.equal(s.exists(`quests/qa/memory/candidates.${HOST_NAME}.md`), false);
        assert.equal(s.read('quests/qa/memory/candidates.bomber.md'), '- 2026-05-02T00:00:00.000Z [bomber] {session=z file=facts.md} another host\n', 'another host\'s file stays');

        const journal = s.read('quests/qa/qa.mbp.qa.md');
        assert.ok(journal.startsWith('# Q&A — qa (mbp)\n\npreamble\n\n'));
        assert.ok(journal.includes('### written by hand: kept as it is'), 'an existing block keeps its text');
        assert.deepEqual(parseQaJournal(journal).map((b) => b.id.replace(/-v11-.*/, '')), ['g-early', 'q', 'a', 'q', 'a', 'g-late']);

        // Once more (the old questions file again, e.g. brought back by a reconcile): nothing twice.
        s.write('quests/qa/questions.qa.md', OLD_QUESTIONS);
        s.step(true);
        assert.equal(s.read('quests/qa/qa.mbp.qa.md'), journal);
        assert.equal(s.exists('quests/qa/questions.qa.md'), false);

        // The curated merge on its own: nothing to add answers the target as it is.
        const target = '- 2026-06-02T00:00:00.000Z [old] x\n';
        assert.deepEqual(mergeCuratedMemory(target, target), { text: target, added: 0 });
    });

    test('NM-5: the old journals with odd content', () => {
        const [plan, picker] = parseOldQuestionsJournal(OLD_QUESTIONS);
        assert.equal(plan.questions.length, 2, 'a numbered line inside fenced code is no new question');
        assert.equal(plan.questions[1], 'A question with code:\n```text\n## 2026-01-01T00:00:00.000Z — not an entry\n3. not a question\n### Answer\n```');
        assert.equal(plan.answer, 'Postgres, and no.\n## not a heading\n\n```\ncode\n```');
        assert.deepEqual([picker.questions, picker.answer, picker.source], [[], '', 'timeout']);
        assert.deepEqual(parseOldQuestionsJournal('# Questions — x\n\nno entries\n'), []);

        // Written as blocks, the texts read back as they were.
        const s = sandbox();
        s.write('quests/qa/questions.qa.md', OLD_QUESTIONS);
        s.write('quests/qa/decisions.qa.md', OLD_DECISIONS);
        s.write('quests/qb/questions.qb.md', '# Questions — qb\n\nEvery question …\n');
        s.write('quests/qb/decisions.qb.md', '# Decisions — qb\n');
        const r = s.step(true);
        assert.deepEqual(r.problems, []);
        const items = combineQaBlocks(parseQaJournal(s.read('quests/qa/qa.mbp.qa.md')));
        assert.equal(items.find((i) => i.title === 'Migration plan')!.questions![1], plan.questions[1]);
        // An empty old journal: removed, no journal created.
        assert.ok(r.changes.some((c) => c.quest === 'qb' && c.detail === 'remove quests/qb/questions.qb.md (no entries)'));
        assert.equal(s.exists('quests/qb/questions.qb.md'), false);
        assert.equal(s.exists('quests/qb/decisions.qb.md'), false);
        assert.equal(s.exists('quests/qb/qa.mbp.qb.md'), false);
    });

    test('NM-6: the problems', () => {
        const s = sandbox();
        s.write('memory/qa/chat/data.json', '{}');
        s.write('memory/qa/chat/facts.md', '- a fact\n');
        s.write('quests/qa/history/1.history.json', 'other');
        s.write('memory/qa/history/1.history.json', 'mine');
        s.write('quests/qa/questions.qa.md', 'some text nobody can read\n');
        s.write('quests/qb/quest-notes.qb.md', 'notes\n');
        s.write('memory/qb/walk/facts.md', '- a walk fact\n');
        s.write('quests/qb/memory/candidates.mbp.md', 'a line that is no entry\n');
        const r = s.step(true);
        assert.deepEqual(r.problems.map((p) => `${p.quest}: ${p.detail}`), [
            'qa: memory/qa/chat/data.json is no memory file (.md): it stays',
            'qa: memory/qa/history/1.history.json: quests/qa/history/1.history.json exists with other content; both kept',
            'qa: quests/qa/questions.qa.md holds no entry the step can read: it stays',
            'qb: quests/qb/memory/candidates.mbp.md holds lines that are no candidate entries: the quest\'s old memory stays as it is',
        ]);
        assert.equal(s.read('memory/qa/chat/data.json'), '{}');
        assert.equal(s.exists('memory/qa/chat/facts.md'), false, 'the files that could move did');
        assert.equal(s.read('memory/qa/history/1.history.json'), 'mine');
        assert.equal(s.read('quests/qa/history/1.history.json'), 'other');
        assert.equal(s.read('quests/qa/questions.qa.md'), 'some text nobody can read\n');
        assert.equal(s.read('memory/qb/walk/facts.md'), '- a walk fact\n');
        assert.equal(s.read('quests/qb/notes/quest-notes.md'), 'notes\n', 'the other steps of the quest still run');
        assert.ok(s.exists('memory'), '_ai/memory/ stays while it holds files');
    });

    test('NM-7: through migrateAiFormats', () => {
        const s = sandbox();
        oldQuest(s);
        const merge = (): string | undefined => undefined;
        const dry = migrateAiFormats({ aiRoot: s.ai, hostSlug: HOST, apply: false, merge, formatVersion: 11, today: '2026-11-25' });
        assert.ok(dry.changes.some((c) => c.step === 'memory' && /memory\/qa\/facts\.md/.test(c.detail)));
        const r = migrateAiFormats({ aiRoot: s.ai, hostSlug: HOST, apply: true, merge, formatVersion: 11, today: '2026-11-25' });
        assert.deepEqual(r.problems.filter((p) => ['notes', 'memory', 'qa-journal'].includes(p.step)), []);
        assert.match(s.read('quests/qa/memory/facts.md'), /a flat fact/);
        assert.match(s.read('quests/qa/memory/facts.md'), /a default fact/);
        assert.equal(s.exists('memory'), false);
        assert.equal(s.read('quests/qa/notes/quest-notes.md'), '# Quest Notes — qa\n\nmy notes\n');
        assert.ok(s.exists('quests/qa/qa.mbp.qa.md'));
        assert.match(s.read('format-version.yaml'), /version: 11/);
        const again = migrateAiFormats({ aiRoot: s.ai, hostSlug: HOST, apply: false, merge, formatVersion: 11, today: '2026-11-25' });
        assert.deepEqual(again.changes.filter((c) => ['notes', 'memory', 'qa-journal'].includes(c.step)), []);
    });
});
