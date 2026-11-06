/**
 * The `_ai` format migration's step for `${{ … }}` placeholders (aiFormatMigration.ts, step
 * `expressions`, format version 7): JavaScript expressions become the expression language
 * (templateExpression.ts) in the workspace config, the user overlay and the process definitions.
 *
 *   EM-1 every template string of the workspace config (any depth: profiles, user-message templates, process
 *        action templates), of the user overlay (YAML) and of `_ai/processes/<id>/<id>.process.yaml` is
 *        converted; a dry run writes nothing; the stamp is written; a second run lists nothing
 *   EM-2 a template the step cannot convert stays exactly as it was and is a problem; the other templates are
 *        converted; the stamp is not written while the problem remains
 */

/* eslint-disable @typescript-eslint/naming-convention -- template variable names as they are written */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';

import { migrateAiFormats } from '../aiFormatMigration.js';
import { AI_FORMAT_VERSION, readAiFormatStamp } from '../aiFormatVersion.js';

const ROLE_JS = '${{ vars["role-description"] ? "## Role\\n" + vars["role-description"] + "\\n" : "" }}';
const ROLE_EXPR = '${{ role-description ? "## Role\\n" + role-description + "\\n" : "" }}';

function sandbox(extraTemplate = '') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expression-migration-'));
    const ai = path.join(root, '_ai');
    fs.mkdirSync(path.join(ai, 'quests', 'qa'), { recursive: true });
    const cfg = path.join(root, 'cfg.json');
    const overlay = path.join(root, 'user.yaml');
    const processFile = path.join(ai, 'processes', 'demo', 'demo.process.yaml');
    fs.mkdirSync(path.dirname(processFile), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({
        anthropic: {
            profiles: [{ id: 'p', systemPrompt: `Hello\n${ROLE_JS}` }],
            userMessageTemplates: [{ id: 't', template: '${{ vars["file.name"] || "(none)" }}' + extraTemplate }],
        },
        processActionTemplates: { proceed: 'x ${{ vars.substep ? "S" : "" }} y' },
        other: 42,
    }, null, 2) + '\n');
    fs.writeFileSync(overlay, `# mine\nanthropic:\n  profiles:\n    - id: q\n      systemPrompt: '${ROLE_JS.replace(/'/g, "''")}'\n`);
    fs.writeFileSync(processFile, [
        'id: demo',
        'phases:',
        '- id: one',
        '  prompt: "Run ${{ vars[\\"custom-instructions\\"] ? \\"with: \\" + vars[\\"custom-instructions\\"] : \\"\\" }}"',
        '  steps:',
        '  - id: a  # first',
        '',
    ].join('\n'));
    const run = (apply: boolean) => migrateAiFormats({
        aiRoot: ai, hostSlug: 'mbp', apply, merge: () => undefined, workspaceConfigPath: cfg, userConfigPath: overlay, today: '2026-11-06',
    });
    return { ai, cfg, overlay, processFile, run };
}

describe('expression migration', () => {
    test('EM-1: converted everywhere', () => {
        const s = sandbox();
        const before = [s.cfg, s.overlay, s.processFile].map((f) => fs.readFileSync(f, 'utf8'));
        const dry = s.run(false);
        const listed = dry.changes.filter((c) => c.step === 'expressions');
        assert.equal(listed.length, 3, JSON.stringify(listed));
        assert.deepEqual(dry.problems, []);
        assert.deepEqual([s.cfg, s.overlay, s.processFile].map((f) => fs.readFileSync(f, 'utf8')), before, 'a dry run writes nothing');

        const applied = s.run(true);
        assert.deepEqual(applied.problems, []);
        const cfg = JSON.parse(fs.readFileSync(s.cfg, 'utf8'));
        assert.equal(cfg.anthropic.profiles[0].systemPrompt, `Hello\n${ROLE_EXPR}`);
        assert.equal(cfg.anthropic.userMessageTemplates[0].template, '${{ file.name || "(none)" }}');
        assert.equal(cfg.processActionTemplates.proceed, 'x ${{ substep ? "S" : "" }} y');
        assert.equal(cfg.other, 42);
        const overlay = fs.readFileSync(s.overlay, 'utf8');
        assert.equal(parse(overlay).anthropic.profiles[0].systemPrompt, ROLE_EXPR);
        const proc = fs.readFileSync(s.processFile, 'utf8');
        assert.equal(parse(proc).phases[0].prompt, 'Run ${{ custom-instructions ? "with: " + custom-instructions : "" }}');
        assert.match(proc, /- id: a +# first/, 'the process file keeps its comment');
        assert.match(proc, /^- id: one$/m, 'and its sequence style');
        assert.equal(readAiFormatStamp(s.ai)?.version, AI_FORMAT_VERSION);
        assert.deepEqual(s.run(false).changes, [], 'a second run lists nothing');
    });

    test('EM-2: a template that cannot be converted', () => {
        const s = sandbox(' ${{ path.basename(vars.workspaceFolder) }}');
        const r = s.run(true);
        const problems = r.problems.filter((p) => p.step === 'expressions');
        assert.equal(problems.length, 1);
        assert.match(problems[0].detail, /anthropic\.userMessageTemplates\[0\]\.template.*path\.basename/);
        const cfg = JSON.parse(fs.readFileSync(s.cfg, 'utf8'));
        assert.equal(cfg.anthropic.userMessageTemplates[0].template, '${{ vars["file.name"] || "(none)" }} ${{ path.basename(vars.workspaceFolder) }}', 'left exactly as it was');
        assert.equal(cfg.anthropic.profiles[0].systemPrompt, `Hello\n${ROLE_EXPR}`, 'the others are converted');
        assert.equal(readAiFormatStamp(s.ai), undefined, 'no stamp while a problem remains');
    });
});
