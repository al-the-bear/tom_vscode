/**
 * `npm test` runs every stage (scripts/run-test-stages.cjs, qrd3).
 *
 * The old chain (`a && b && c …`) stopped at the first failing stage, so a
 * failure in test:tools meant utils, managers, handlers and the audit never
 * ran — and the output gave no sign of it.
 *
 *   RS-1 the stages: lint:media, every `test:*` script of package.json in its order, audit:tools last
 *   RS-2 a failing stage does not stop the run: every stage runs, the exit code is 1; all passing → 0
 *   RS-3 node:test's summary lines give each stage's counts; a stage without them reports none
 *   RS-4 the summary lists every stage with its result and names the failed ones
 *   RS-5 `npm test` is the runner
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const runner = require(path.join(EXT_ROOT, 'scripts', 'run-test-stages.cjs')) as {
    stagesOf(scripts: Record<string, string>): string[];
    runStages(stages: string[], run: (stage: string) => Promise<{ code: number; output: string }>): Promise<StageResult[]>;
    parseCounts(output: string): { tests: number; pass: number; fail: number } | null;
    summarize(results: StageResult[]): string;
    exitCode(results: StageResult[]): number;
};
interface StageResult { stage: string; code: number; ms: number; counts: { tests: number; pass: number; fail: number } | null }

const PKG = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

const NODE_TEST_TAIL = 'ℹ tests 12\nℹ suites 3\nℹ pass 11\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\n';

describe('run-test-stages', () => {
    test('RS-1: the stages come from package.json', () => {
        const stages = runner.stagesOf({ 'lint:media': 'x', 'test:b': 'x', compile: 'x', 'test:a': 'x', 'audit:tools': 'x' });
        assert.deepEqual(stages, ['lint:media', 'test:b', 'test:a', 'audit:tools']);
        const real = runner.stagesOf(PKG.scripts);
        assert.equal(real[0], 'lint:media');
        assert.equal(real[real.length - 1], 'audit:tools');
        for (const name of Object.keys(PKG.scripts).filter((k) => k.startsWith('test:'))) {
            assert.ok(real.includes(name), `${name} is a stage`);
        }
    });

    test('RS-2: a failure does not stop the run', async () => {
        const ran: string[] = [];
        const results = await runner.runStages(['a', 'b', 'c'], async (stage) => {
            ran.push(stage);
            return { code: stage === 'a' ? 1 : 0, output: '' };
        });
        assert.deepEqual(ran, ['a', 'b', 'c'], 'every stage ran after the first failed');
        assert.deepEqual(results.map((r) => r.code), [1, 0, 0]);
        assert.equal(runner.exitCode(results), 1);
        const ok = await runner.runStages(['a', 'b'], async () => ({ code: 0, output: '' }));
        assert.equal(runner.exitCode(ok), 0);
        const broken = await runner.runStages(['a', 'b'], async (s) => { if (s === 'a') { throw new Error('spawn failed'); } return { code: 0, output: '' }; });
        assert.deepEqual(broken.map((r) => r.code), [1, 0], 'a stage that cannot start counts as failed, and the run goes on');
    });

    test('RS-3: the counts', () => {
        assert.deepEqual(runner.parseCounts(`noise\n${NODE_TEST_TAIL}`), { tests: 12, pass: 11, fail: 1 });
        assert.equal(runner.parseCounts('✖ 712 problems (0 errors, 712 warnings)'), null);
    });

    test('RS-4: the summary', async () => {
        const results = await runner.runStages(['lint:media', 'test:tools', 'test:utils'], async (stage) =>
            stage === 'test:tools' ? { code: 1, output: NODE_TEST_TAIL } : { code: 0, output: '' });
        const text = runner.summarize(results);
        for (const stage of ['lint:media', 'test:tools', 'test:utils']) { assert.match(text, new RegExp(stage)); }
        assert.match(text, /test:tools.*FAILED.*11 passed, 1 failed/);
        assert.match(text, /test:utils.*ok/);
        assert.match(text, /1 of 3 stages failed: test:tools/);
        assert.match(runner.summarize(results.filter((r) => r.code === 0)), /all 2 stages passed/);
    });

    test('RS-5: npm test is the runner', () => {
        assert.equal(PKG.scripts.test, 'node scripts/run-test-stages.cjs');
    });
});
