/**
 * The `_ai` format version 10 step (utils/aspectFileMigration.ts, the `aspect-files` step of
 * utils/aiFormatMigration.ts; gsel16): every aspect's `section.yaml` becomes `aspect.yaml`.
 *
 *   AF-1 the text: `options` renamed `choices` in place (comments, order and sequence style kept), the schema
 *        line pointing at aspect-guideline.schema.json; nothing to change but the file name; refusals (no map,
 *        both keys, broken YAML)
 *   AF-2 on a sandbox `_ai`: a dry run lists the rename and writes nothing; applied, `section.yaml` is gone and
 *        `aspect.yaml` reads as an aspect with its choices; the stamp says the current version; a second run lists nothing
 *   AF-3 a folder with both files is a problem and left as it is; the stamp is not written then
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { aspectDefinitionText, DEFINITION_FILE, LEGACY_DEFINITION_FILE } from '../aspectFileMigration';
import { migrateAiFormats } from '../aiFormatMigration';
import { AI_FORMAT_VERSION, readAiFormatStamp } from '../aiFormatVersion';
import { readAspectSections } from '../../services/aspectGuidelinesStore';

const LEGACY = [
    '# yaml-language-server: $schema=../../../.tom/json-schema/aspect-guidelines/aspect-guideline-section.schema.json',
    'name: Extra explanations',
    '# the options, in the order the picker shows them',
    'options:',
    '- short',
    '- long',
    'default: short',
    '',
].join('\n');

function sandbox(): { ai: string; folder: string } {
    const ai = fs.mkdtempSync(path.join(os.tmpdir(), 'aspect-files-'));
    fs.writeFileSync(path.join(ai, 'format-version.yaml'), 'version: 9\ndate: 2026-11-01\n');
    const folder = path.join(ai, 'aspect_guidelines', 'extra_explanations');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, LEGACY_DEFINITION_FILE), LEGACY);
    fs.writeFileSync(path.join(folder, 'short.md'), 'Explain briefly.\n');
    fs.writeFileSync(path.join(folder, 'long.md'), 'Explain in detail.\n');
    return { ai, folder };
}

const run = (ai: string, apply: boolean) => migrateAiFormats({ aiRoot: ai, hostSlug: 'host1', apply, merge: () => undefined, quests: [] });

describe('aspect files (format version 10)', () => {
    test('AF-1: the text', () => {
        const { text, changed } = aspectDefinitionText(LEGACY);
        assert.equal(text, LEGACY
            .replace('aspect-guideline-section.schema.json', 'aspect-guideline.schema.json')
            .replace('\noptions:\n', '\nchoices:\n'), 'only the key and the schema line change; comments and the sequence style stay');
        assert.deepEqual(changed, ['schema line: aspect-guideline.schema.json', '`options` → `choices`']);
        const indented = aspectDefinitionText('name: X\noptions:\n  - a\n');
        assert.equal(indented.text, 'name: X\nchoices:\n  - a\n', 'an indented sequence stays indented');
        assert.deepEqual(aspectDefinitionText('name: X\n'), { text: 'name: X\n', changed: [] }, 'nothing but the file name');
        assert.throws(() => aspectDefinitionText('- a\n'), /no YAML map/);
        assert.throws(() => aspectDefinitionText('name: X\noptions: [a]\nchoices: [a]\n'), /both `options` and `choices`/);
        assert.throws(() => aspectDefinitionText('name: [unclosed\n'));
    });

    test('AF-2: on a sandbox _ai', () => {
        const { ai, folder } = sandbox();
        try {
            assert.ok(AI_FORMAT_VERSION >= 10);
            const dry = run(ai, false);
            const step = dry.changes.filter((c) => c.step === 'aspect-files');
            assert.equal(step.length, 1, JSON.stringify(dry.changes));
            assert.match(step[0].detail, /aspect_guidelines\/extra_explanations\/section\.yaml → aspect\.yaml \(schema line: aspect-guideline\.schema\.json, `options` → `choices`\)/);
            assert.ok(fs.existsSync(path.join(folder, LEGACY_DEFINITION_FILE)), 'a dry run writes nothing');
            assert.equal(fs.existsSync(path.join(folder, DEFINITION_FILE)), false);

            const applied = run(ai, true);
            assert.deepEqual(applied.problems, []);
            assert.equal(fs.existsSync(path.join(folder, LEGACY_DEFINITION_FILE)), false, 'section.yaml is gone');
            assert.match(fs.readFileSync(path.join(folder, DEFINITION_FILE), 'utf8'), /aspect-guideline\.schema\.json\nname: Extra explanations\n# the options, in the order the picker shows them\nchoices:\n- short\n- long\n/);
            const { sections, problems } = readAspectSections(path.join(ai, 'aspect_guidelines'));
            assert.deepEqual(problems, []);
            assert.deepEqual(sections.map((s) => [s.id, s.defaultOption, s.options.map((o) => o.name)]), [['extra_explanations', 'short', ['short', 'long']]]);
            assert.equal(readAiFormatStamp(ai)?.version, AI_FORMAT_VERSION);
            assert.deepEqual(run(ai, true).changes, [], 'a second run: nothing');
        } finally {
            fs.rmSync(ai, { recursive: true, force: true });
        }
    });

    test('AF-3: both files', () => {
        const { ai, folder } = sandbox();
        try {
            fs.writeFileSync(path.join(folder, DEFINITION_FILE), 'name: Mine\n');
            const r = run(ai, true);
            assert.ok(r.problems.some((p) => p.step === 'aspect-files' && /aspect\.yaml exists beside it/.test(p.detail)), JSON.stringify(r.problems));
            assert.equal(fs.readFileSync(path.join(folder, LEGACY_DEFINITION_FILE), 'utf8'), LEGACY, 'both left as they are');
            assert.equal(fs.readFileSync(path.join(folder, DEFINITION_FILE), 'utf8'), 'name: Mine\n');
            assert.equal(readAiFormatStamp(ai)?.version, 9, 'not every step done: no stamp');
            assert.ok(readAspectSections(path.join(ai, 'aspect_guidelines')).sections.length === 1, 'the store reads aspect.yaml');
        } finally {
            fs.rmSync(ai, { recursive: true, force: true });
        }
    });
});
