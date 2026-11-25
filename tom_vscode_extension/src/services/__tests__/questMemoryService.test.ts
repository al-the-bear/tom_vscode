/**
 * The quest memory on disk (TwoTierMemoryService over src/services/questMemoryFiles.ts): the folder
 * `_ai/quests/<quest>/memory/`, without a session level.
 *
 *   QM-1 the folder: `memory/` in the quest folder; a write creates it; no session folder and nothing under
 *        `_ai/memory/` is created; the list names each file's kind
 *   QM-2 the extraction's candidates: written to this host's `candidates.<host>.md`, each entry naming its session
 *        and the curated file it is meant for; `facts.md` is left untouched; the same fact is not added twice
 *   QM-3 `${existingMemory}`: the curated target file, then this host's candidates meant for that file
 *   QM-4 the injection: curated files (newest first) before this host's candidates under their heading; the token
 *        budget; with a suffix only `facts-<suffix>.md` and the candidates meant for it; other hosts' candidates
 *        are never injected
 *   QM-5 the interim rule (old place `_ai/memory/<quest>/<session>/`): while the old quest folder exists, the old
 *        files of the send's session follow the new ones within the same budget (with a suffix: only
 *        `facts-<suffix>.md` of `default@default`); without the old folder nothing is added; the old files are
 *        neither listed nor written
 *   QM-6 remember / forget (the Anthropic handler's keyword triggers) write `facts.md` of the quest folder; forget
 *        also takes the fact out of this host's candidates and leaves another host's candidates file alone
 *   QM-7 the memory placeholder hands the send's session to the injection (`memorySession`)
 *   QM-8 the candidates file is named by the host slug; this host's file under the old name (the host name) is read
 *        with it, merged into it on the next write and then deleted
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const stubHandle = installVscodeStub({});

import { TwoTierMemoryService, currentMemoryHost, parseMemoryEntries } from '../memory-service.js';
import { candidatesFileName, candidatesHeading, parseCandidateText } from '../questMemoryFiles.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';
import { resolveVariables } from '../../utils/variableResolver.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { hostSlugOf } from '../../utils/hostSlug.js';

TomAiConfiguration.init({} as never);

const QUEST = 'memory_test_quest';
const OWN = candidatesFileName(hostSlugOf());
const OTHER = 'candidates.some-other-host.md';

let root: string;
let svc: TwoTierMemoryService;

const memoryDir = (): string => path.join(root, '_ai', 'quests', QUEST, 'memory');
const oldDir = (session: string): string => path.join(root, '_ai', 'memory', QUEST, session);

function put(file: string, body: string, mtimeSeconds?: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf-8');
    if (mtimeSeconds !== undefined) { fs.utimesSync(file, mtimeSeconds, mtimeSeconds); }
}

function tree(dir: string, base = dir): string[] {
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => e.isDirectory() ? tree(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')])
        .sort();
}

beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quest-memory-')));
    stubHandle.setWorkspaceFolders([root]);
    svc = TwoTierMemoryService.instance;
});

describe('quest memory in the quest folder', () => {
    test('QM-1: the folder', () => {
        assert.equal(svc.scopeFolder('quest', QUEST), memoryDir());
        assert.equal(svc.filePath('quest', 'facts.md', QUEST), path.join(memoryDir(), 'facts.md'));
        assert.equal(fs.existsSync(memoryDir()), false, 'naming the folder does not create it');
        assert.deepEqual(svc.list('quest', QUEST), []);
        assert.equal(svc.read('quest', 'facts.md', QUEST), '');

        svc.append('quest', 'facts.md', 'A curated fact.', QUEST);
        svc.replaceSection('quest', 'decisions.md', 'Build', 'on mbp', QUEST);
        svc.addCandidates('- a candidate', { session: 'chat', targetFile: 'facts.md' }, QUEST);
        assert.deepEqual(tree(path.join(root, '_ai')), [
            `quests/${QUEST}/memory/${OWN}`,
            `quests/${QUEST}/memory/decisions.md`,
            `quests/${QUEST}/memory/facts.md`,
        ], 'the files sit directly in memory/: no session folder, nothing under _ai/memory/');
        assert.equal(fs.readFileSync(path.join(memoryDir(), 'facts.md'), 'utf-8'), 'A curated fact.\n');
        assert.deepEqual(svc.listWithMeta('quest', QUEST).map((e) => [e.file, e.kind]).sort(),
            [[OWN, 'candidates'], ['decisions.md', 'curated'], ['facts.md', 'curated']]);

        svc.delete('quest', 'decisions.md', QUEST);
        assert.deepEqual(svc.list('quest', QUEST).sort(), [OWN, 'facts.md'].sort());
        assert.throws(() => svc.filePath('quest', '../outside.md', QUEST), /Invalid memory file path/);
    });

    test('QM-2: the extraction writes candidates', () => {
        svc.write('quest', 'facts.md', 'Curated before.\n', QUEST);
        const written = svc.addCandidates('- The build runs on mbp.\n- Tests use node:test.', { session: 'walk@aifmt-3', targetFile: 'facts.md' }, QUEST);
        assert.equal(written, OWN);
        assert.equal(svc.candidatesFile(), OWN);
        assert.equal(fs.readFileSync(path.join(memoryDir(), 'facts.md'), 'utf-8'), 'Curated before.\n', 'the curated file is untouched');

        const entries = parseMemoryEntries(fs.readFileSync(path.join(memoryDir(), OWN), 'utf-8'));
        assert.equal(entries.length, 2);
        for (const e of entries) {
            assert.equal(e.host, currentMemoryHost());
            assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
        }
        assert.deepEqual(entries.map((e) => parseCandidateText(e.text)).sort((a, b) => a.text.localeCompare(b.text)), [
            { session: 'walk@aifmt-3', targetFile: 'facts.md', text: 'Tests use node:test.' },
            { session: 'walk@aifmt-3', targetFile: 'facts.md', text: 'The build runs on mbp.' },
        ]);
        for (const line of fs.readFileSync(path.join(memoryDir(), OWN), 'utf-8').trimEnd().split('\n')) {
            assert.match(line, /^- \S+ \[[^\]]+\] \{session=walk@aifmt-3 file=facts\.md\} /);
        }

        // Another template's target, another session, no session: each entry names its own.
        svc.addCandidates('- A gemma fact.', { session: 'chat', targetFile: 'facts-gemma4.md' }, QUEST);
        svc.addCandidates('- From no session.', { targetFile: 'facts.md' }, QUEST);
        const all = parseMemoryEntries(svc.read('quest', OWN, QUEST)).map((e) => parseCandidateText(e.text));
        assert.deepEqual(all.find((c) => c.text === 'A gemma fact.'), { session: 'chat', targetFile: 'facts-gemma4.md', text: 'A gemma fact.' });
        assert.deepEqual(all.find((c) => c.text === 'From no session.'), { targetFile: 'facts.md', text: 'From no session.' });
        assert.equal(all.length, 4);
        assert.deepEqual(svc.list('quest', QUEST).sort(), [OWN, 'facts.md'].sort(), 'no facts-gemma4.md is created by the extraction');

        // A stamped line is kept as stamped; adding it again adds nothing.
        const stamped = '- 2026-06-01T08:45:07.182Z [mbp.local] Stamped already.';
        svc.addCandidates(stamped, { session: 'chat', targetFile: 'facts.md' }, QUEST);
        svc.addCandidates(stamped, { session: 'chat', targetFile: 'facts.md' }, QUEST);
        const body = svc.read('quest', OWN, QUEST);
        assert.equal(body.split('\n').filter((l) => l.includes('Stamped already.')).length, 1);
        assert.match(body, /^- 2026-06-01T08:45:07\.182Z \[mbp\.local\] \{session=chat file=facts\.md\} Stamped already\.$/m);
        assert.deepEqual(svc.candidatesFor('facts-gemma4.md', QUEST).map((e) => parseCandidateText(e.text).text), ['A gemma fact.']);
    });

    test('QM-3: ${existingMemory} is the curated file, then the candidates meant for it', () => {
        assert.equal(svc.existingMemoryForExtraction('facts.md', QUEST), '', 'nothing known yet');
        svc.write('quest', 'facts.md', '- 2026-05-01T00:00:00Z [mbp] Curated fact.\n', QUEST);
        put(path.join(memoryDir(), OWN), [
            '- 2026-06-02T00:00:00Z [h] {session=chat file=facts.md} Newer candidate.',
            '- 2026-06-01T00:00:00Z [h] {session=walk file=facts.md} Older candidate.',
            '- 2026-06-03T00:00:00Z [h] {session=chat file=facts-gemma4.md} For another file.',
            '- 2026-05-31T00:00:00Z [h] A line without the prefix.',
            '',
        ].join('\n'));
        put(path.join(memoryDir(), OTHER), '- 2026-06-04T00:00:00Z [o] {session=chat file=facts.md} Another host\'s candidate.\n');
        assert.equal(svc.existingMemoryForExtraction('facts.md', QUEST), [
            '- 2026-05-01T00:00:00Z [mbp] Curated fact.',
            '- 2026-06-02T00:00:00Z [h] Newer candidate.',
            '- 2026-06-01T00:00:00Z [h] Older candidate.',
            '- 2026-05-31T00:00:00Z [h] A line without the prefix.',
        ].join('\n'), 'the curated content, then this host\'s candidates for the file (a line without the prefix is meant for facts.md)');
        assert.equal(svc.existingMemoryForExtraction('facts-gemma4.md', QUEST), '- 2026-06-03T00:00:00Z [h] For another file.',
            'no curated file yet: the candidates alone');
    });

    test('QM-4: the injection', () => {
        put(path.join(memoryDir(), 'facts.md'), 'older curated\n', 1000);
        put(path.join(memoryDir(), 'decisions.md'), 'newer curated\n', 2000);
        put(path.join(memoryDir(), 'facts-gemma4.md'), 'gemma curated\n', 500);
        const forFacts = '- 2026-06-02T00:00:00Z [h] {session=chat file=facts.md} Candidate for facts.';
        const forGemma = '- 2026-06-01T00:00:00Z [h] {session=chat file=facts-gemma4.md} Candidate for gemma.';
        put(path.join(memoryDir(), OWN), `${forGemma}\n${forFacts}\n`, 3000);
        put(path.join(memoryDir(), OTHER), '- 2026-06-05T00:00:00Z [o] {session=chat file=facts.md} Other host candidate.\n', 4000);

        const all = svc.injectForSystemPrompt(3000, QUEST);
        assert.equal(all.text, [
            '## Memory',
            '',
            '### quest/decisions.md',
            'newer curated',
            '',
            '### quest/facts.md',
            'older curated',
            '',
            '### quest/facts-gemma4.md',
            'gemma curated',
            '',
            candidatesHeading(OWN),
            forFacts,
            forGemma,
            '',
        ].join('\n'), 'curated newest first, then this host\'s candidates (newest first) under their heading');
        assert.deepEqual(all.included.map((e) => [e.kind, e.file]),
            [['curated', 'decisions.md'], ['curated', 'facts.md'], ['curated', 'facts-gemma4.md'], ['candidates', OWN]]);
        assert.doesNotMatch(all.text, /Other host candidate|some-other-host/, 'another host\'s candidates are not injected');
        assert.equal(all.tokens, Math.ceil(all.text.length / 4));

        // The suffix: only the profile's bucket and the candidates meant for it.
        const gemma = svc.injectForSystemPrompt(3000, QUEST, 'gemma4');
        assert.equal(gemma.text, `## Memory\n\n### quest/facts-gemma4.md\ngemma curated\n\n${candidatesHeading(OWN)}\n${forGemma}\n`);
        assert.equal(svc.injectForSystemPrompt(3000, QUEST, 'no-such-profile').text, '');

        // The budget, in tokens of four characters: what does not fit is left out.
        const first = '### quest/decisions.md\nnewer curated\n';
        const tight = svc.injectForSystemPrompt(Math.ceil(first.length / 4), QUEST);
        assert.deepEqual(tight.included.map((e) => e.file), ['decisions.md']);
        assert.equal(svc.injectForSystemPrompt(0, QUEST).text, '');
        // The quest without memory: nothing.
        assert.deepEqual(svc.injectForSystemPrompt(3000, 'quest_without_memory'), { text: '', tokens: 0, included: [] });
    });

    test('QM-5: the interim rule for the old place', () => {
        put(path.join(memoryDir(), 'facts.md'), 'new place fact\n', 1000);
        const withoutOld = svc.injectForSystemPrompt(3000, QUEST, undefined, 'chat').text;
        assert.equal(withoutOld, '## Memory\n\n### quest/facts.md\nnew place fact\n', 'no old folder: the new place alone');

        put(path.join(oldDir('chat'), 'facts.md'), 'old chat fact\n', 100);
        put(path.join(oldDir('walk'), 'facts.md'), 'old walk fact\n', 200);
        put(path.join(oldDir('default@default'), 'facts.md'), 'old default fact\n', 300);
        put(path.join(oldDir('default@default'), 'facts-gemma4.md'), 'old gemma fact\n', 400);
        const before = tree(path.join(root, '_ai', 'memory'));

        const chat = svc.injectForSystemPrompt(3000, QUEST, undefined, 'chat');
        assert.equal(chat.text, '## Memory\n\n### quest/facts.md\nnew place fact\n\n### quest/facts.md (session chat)\nold chat fact\n',
            'the send\'s session\'s old files follow the new ones');
        assert.deepEqual(chat.included.map((e) => [e.kind, e.file]), [['curated', 'facts.md'], ['old-session', 'facts.md']]);
        assert.match(svc.injectForSystemPrompt(3000, QUEST, undefined, 'walk').text, /\(session walk\)\nold walk fact\n$/);
        assert.doesNotMatch(svc.injectForSystemPrompt(3000, QUEST, undefined, 'walk').text, /old chat fact|old default fact/);
        assert.match(svc.injectForSystemPrompt(3000, QUEST).text, /\(session default@default\)\nold default fact\n/, 'no session named: default@default');
        assert.equal(svc.injectForSystemPrompt(3000, QUEST, undefined, 'never-ran').text, withoutOld, 'a session without old files');

        // With a suffix: only facts-<suffix>.md of default@default, whatever the send's session.
        assert.equal(svc.injectForSystemPrompt(3000, QUEST, 'gemma4', 'chat').text,
            '## Memory\n\n### quest/facts-gemma4.md (session default@default)\nold gemma fact\n');

        // Within the same budget: the new place first, the old one only when room is left.
        const newBlock = '### quest/facts.md\nnew place fact\n';
        assert.equal(svc.injectForSystemPrompt(Math.ceil(newBlock.length / 4), QUEST, undefined, 'chat').text, `## Memory\n\n${newBlock}`);

        // Read-only, and not part of the memory the tools and the panel see.
        assert.deepEqual(tree(path.join(root, '_ai', 'memory')), before, 'nothing is written to the old place');
        assert.deepEqual(svc.list('quest', QUEST), ['facts.md']);
        assert.doesNotMatch(svc.readAll('quest', QUEST), /old chat fact/);
        svc.append('quest', 'facts.md', 'one more', QUEST);
        svc.addCandidates('- a candidate', { session: 'chat', targetFile: 'facts.md' }, QUEST);
        assert.deepEqual(tree(path.join(root, '_ai', 'memory')), before, 'writes go to the quest folder');
    });

    test('QM-6: remember and forget write the quest folder\'s curated files', () => {
        const handler = AnthropicHandler.instance as unknown as {
            applyKeywordTriggers(userText: string, questId?: string): { cleaned: string; applied: string[] };
        };
        const remembered = handler.applyKeywordTriggers('Remember: The release branch is main.\nPlease go on.', QUEST);
        assert.deepEqual(remembered, { cleaned: 'Please go on.', applied: ['remember: The release branch is main.'] });
        assert.equal(fs.readFileSync(path.join(memoryDir(), 'facts.md'), 'utf-8'), 'The release branch is main.\n');
        assert.deepEqual(tree(path.join(root, '_ai')), [`quests/${QUEST}/memory/facts.md`], 'facts.md of the quest folder, nothing else');

        put(path.join(memoryDir(), 'decisions.md'), 'Keep this.\nThe release branch was develop.\n');
        put(path.join(memoryDir(), OWN), '- 2026-06-01T00:00:00Z [h] {session=chat file=facts.md} The release branch is main.\n- 2026-06-02T00:00:00Z [h] {session=chat file=facts.md} Unrelated.\n');
        const otherBody = '- 2026-06-03T00:00:00Z [o] {session=chat file=facts.md} The release branch is main.\n';
        put(path.join(memoryDir(), OTHER), otherBody);
        const forgotten = handler.applyKeywordTriggers('forget: release branch', QUEST);
        assert.deepEqual(forgotten, { cleaned: '', applied: ['forget: release branch'] });
        assert.equal(fs.readFileSync(path.join(memoryDir(), 'facts.md'), 'utf-8'), '');
        assert.equal(fs.readFileSync(path.join(memoryDir(), 'decisions.md'), 'utf-8'), 'Keep this.\n');
        assert.equal(fs.readFileSync(path.join(memoryDir(), OWN), 'utf-8'), '- 2026-06-02T00:00:00Z [h] {session=chat file=facts.md} Unrelated.\n',
            'the forgotten fact does not come back as a candidate');
        assert.equal(fs.readFileSync(path.join(memoryDir(), OTHER), 'utf-8'), otherBody, 'another host\'s candidates file is that host\'s to write');
    });

    test('QM-7: the memory placeholder hands the send\'s session on', () => {
        put(path.join(memoryDir(), 'facts.md'), 'new place fact\n', 1000);
        put(path.join(oldDir('walk'), 'facts.md'), 'old walk fact\n', 200);
        put(path.join(oldDir('default@default'), 'facts.md'), 'old default fact\n', 300);
        const walk = resolveVariables('${memory}', { values: { quest: QUEST, memorySession: 'walk' }, includeEditor: false });
        assert.equal(walk, '## Memory\n\n### quest/facts.md\nnew place fact\n\n### quest/facts.md (session walk)\nold walk fact\n');
        const none = resolveVariables('${memory-quest}', { values: { quest: QUEST }, includeEditor: false });
        assert.match(none, /### quest\/facts\.md\nnew place fact\n\n### quest\/facts\.md \(session default@default\)\nold default fact\n$/);
    });

    test('QM-8: the candidates file under the host slug, the old name merged', () => {
        const before = svc.legacyCandidatesHost;
        try {
            svc.legacyCandidatesHost = 'Old-Host.example.org';
            const old = 'candidates.Old-Host.example.org.md';
            assert.equal(svc.candidatesFile(), `candidates.${hostSlugOf()}.md`);
            assert.equal(svc.legacyCandidatesFile(), old);
            put(path.join(memoryDir(), old), '- 2026-01-01T00:00:00.000Z [Old-Host] {session=chat file=facts.md} An old candidate.\n');
            // Read with the slug-named file before any write.
            assert.deepEqual(svc.candidatesFor('facts.md', QUEST).map((e) => parseCandidateText(e.text).text), ['An old candidate.']);
            assert.match(svc.existingMemoryForExtraction('facts.md', QUEST), /An old candidate\./);
            // The next write merges it and deletes the old file.
            svc.addCandidates('- A new candidate.', { session: 'work', targetFile: 'facts.md' }, QUEST);
            assert.equal(fs.existsSync(path.join(memoryDir(), old)), false);
            const merged = parseMemoryEntries(fs.readFileSync(path.join(memoryDir(), OWN), 'utf-8')).map((e) => parseCandidateText(e.text).text);
            assert.deepEqual(merged, ['A new candidate.', 'An old candidate.']);
            // The same name as the slug: no old file.
            svc.legacyCandidatesHost = hostSlugOf();
            assert.equal(svc.legacyCandidatesFile(), undefined);
        } finally {
            svc.legacyCandidatesHost = before;
        }
    });
});
