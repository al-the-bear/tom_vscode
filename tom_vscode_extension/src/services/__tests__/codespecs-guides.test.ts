/**
 * The CodeSpecs workflow guides (src/services/codespecs-guides.ts): the two
 * documents the Phase-4 workflow is written in, packaged with the extension,
 * read as numbered sections, and the stage runbooks built from them.
 *
 *   GD-1  both guides are packaged and equal their sources (both in ai_build)
 *   GD-2  the outline: numbered sections with level and line; unnumbered subheadings and fenced
 *         `#` lines are not sections of their own
 *   GD-3  a section is its whole subtree; an unknown number names the outline; a too-large
 *         section answers its own text and its children instead
 *   GD-4  the runbooks: every stage has one, it names its tools and carries its guide sections;
 *         arguments are filled in; an unknown runbook is refused
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    GUIDES,
    RUNBOOKS,
    guideOutline,
    guideSection,
    parseGuide,
    runbookText,
} from '../codespecs-guides.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCES: Record<string, string> = {
    mapping: path.resolve(EXT_ROOT, '..', '..', 'ai_build', 'tom_core_codespecs', 'doc', 'codespecs_mapping.md'),
    prompt: path.resolve(EXT_ROOT, '..', '..', 'ai_build', 'tom_specs_model', 'doc', 'codespecs_prompt.md'),
};

const SAMPLE = [
    '# A guide',
    '',
    'Intro.',
    '',
    '## 1. First',
    '',
    'One.',
    '',
    '### 1.1 Inner',
    '',
    'Inner text.',
    '',
    '```markdown',
    '## 9. Not a heading',
    '```',
    '',
    '#### Unnumbered detail',
    '',
    'Detail.',
    '',
    '## 2. Second',
    '',
    'Two.',
    '',
].join('\n');

describe('CodeSpecs guides', () => {
    test('GD-1: packaged and equal to their sources', (t) => {
        for (const g of GUIDES) {
            assert.ok(fs.existsSync(g.file), `missing ${g.file}: run npm run som:pack`);
            const source = SOURCES[g.id];
            if (!fs.existsSync(source)) { t.diagnostic(`no source at ${source}`); continue; }
            assert.equal(fs.readFileSync(g.file, 'utf8'), fs.readFileSync(source, 'utf8'),
                `resources/codespecs/${path.basename(g.file)} is stale: run npm run som:pack -- --catalog-only`);
        }
        assert.deepEqual(GUIDES.map((g) => g.id), ['prompt', 'mapping']);
    });

    test('GD-2: the outline', () => {
        const parsed = parseGuide(SAMPLE);
        assert.deepEqual(parsed.map((s) => [s.number, s.title, s.level, s.line]), [
            ['1', 'First', 2, 5],
            ['1.1', 'Inner', 3, 9],
            ['2', 'Second', 2, 21],
        ]);
        const real = guideOutline('prompt');
        assert.ok(real.sections.some((s) => s.number === '6.2' && /three verdicts/i.test(s.title)), JSON.stringify(real.sections.slice(0, 5)));
        assert.ok(guideOutline('mapping').sections.some((s) => s.number === '1.1.2'));
    });

    test('GD-3: a section', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guides-'));
        const file = path.join(dir, 'g.md');
        fs.writeFileSync(file, SAMPLE);
        const one = guideSection(file, '1');
        assert.ok(one.ok);
        assert.match(one.text, /^## 1\. First/);
        assert.match(one.text, /Inner text\./, 'the subtree');
        assert.match(one.text, /Unnumbered detail/, 'an unnumbered subheading belongs to its section');
        assert.doesNotMatch(one.text, /Second/);
        const missing = guideSection(file, '7');
        assert.equal(missing.ok, false);
        assert.match(missing.ok ? '' : missing.error, /1, 1\.1, 2/);
        const capped = guideSection(file, '1', 20);
        assert.ok(capped.ok && capped.truncated);
        assert.ok(capped.ok && capped.children?.some((c) => c.number === '1.1'));
        assert.doesNotMatch(capped.ok ? capped.text : '', /Inner text/, 'only its own text up to the first child');
        const real = guideSection(GUIDES.find((g) => g.id === 'prompt')!.file, '6.2');
        assert.ok(real.ok && /^### 6\.2 /.test(real.text));
    });

    test('GD-4: the runbooks', () => {
        const names = RUNBOOKS.map((r) => r.name);
        assert.deepEqual(names, ['codespecs-next-step', 'codespecs-stage-a', 'codespecs-extraction', 'codespecs-stage-b',
            'codespecs-stage-c', 'codespecs-authoring-step', 'codespecs-validate']);
        for (const r of RUNBOOKS) {
            const text = runbookText(r.name, { file: 'specs/sbp.docspecs.yaml', step: '10', questId: 'q1', shared: 'out/app_codespec_shared' });
            assert.ok(text.ok, r.name);
            if (!text.ok) { continue; }
            assert.match(text.text, /tomAi_specCodeSpecs[A-Z]\w+/, `${r.name} names its tools`);
            assert.ok(text.text.includes('specs/sbp.docspecs.yaml'), `${r.name}: the file is filled in`);
            for (const ref of r.guideSections) {
                assert.ok(text.text.includes(`(${ref.guide} §${ref.section})`), `${r.name} carries ${ref.guide} §${ref.section}`);
            }
        }
        const step = runbookText('codespecs-authoring-step', { file: 'f.yaml', step: '10' });
        assert.ok(step.ok && step.text.includes('csgen10'));
        assert.deepEqual(runbookText('nope', {}), { ok: false, error: `Unknown runbook "nope". Runbooks: ${names.join(', ')}.` });
    });
});
