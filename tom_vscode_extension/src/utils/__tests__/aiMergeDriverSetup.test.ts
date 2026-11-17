/**
 * Registering the extension's `_ai` merge drivers in git and checking them (utils/aiMergeDriverSetup.ts,
 * vscimpb142c), with a real git and a scratch global config (GIT_CONFIG_GLOBAL).
 *
 *   MS-1 the command line: VS Code's own Node (ELECTRON_RUN_AS_NODE) or this Node; states missing / current /
 *        outdated (another folder or Node) / other (the Python drivers)
 *   MS-2 a fresh `_ai`: no repository, nothing registered, nothing bound; registered for the repository and
 *        bound: every driver current (local), `_ai/.gitattributes` holds the rules, ok; registering again
 *        binds nothing twice
 *   MS-3 the upgrade check: a driver of an older install is outdated and offered for an update where it is set;
 *        the Python drivers are another tool's, not offered
 *   MS-4 git merges with them: two branches each add a live-trail entry and a todo; `git merge` keeps both
 *   MS-5 `_ai` a folder of a larger repository: the rules in `_ai/.gitattributes` apply (git check-attr)
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    checkAiMergeDrivers, classifyDriverCommand, driverCommandLine, installAiMergeDrivers, nodeCommandForGit,
    outdatedDriverUpdate, setUpAiMergeDrivers,
} from '../aiMergeDriverSetup.js';
import { AI_MERGE_DRIVER_NAMES } from '../aiMergeDrivers/index.js';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-merge-setup-')));
const GLOBAL = path.join(SANDBOX, 'gitconfig');
fs.writeFileSync(GLOBAL, '[user]\n\tname = probe\n\temail = probe@example.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
const envBefore = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
process.env.GIT_CONFIG_GLOBAL = GLOBAL;
process.env.GIT_CONFIG_NOSYSTEM = '1';
after(() => {
    if (envBefore.g === undefined) { delete process.env.GIT_CONFIG_GLOBAL; } else { process.env.GIT_CONFIG_GLOBAL = envBefore.g; }
    if (envBefore.s === undefined) { delete process.env.GIT_CONFIG_NOSYSTEM; } else { process.env.GIT_CONFIG_NOSYSTEM = envBefore.s; }
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const CLI = path.join(__dirname, '..', 'aiMergeDriverCli.js');
const NODE = nodeCommandForGit(process.execPath, false);
const opts = { cli: CLI, node: NODE };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('registering the _ai merge drivers', () => {
    test('MS-1: the command line and the states', () => {
        assert.equal(nodeCommandForGit('/Applications/Code.app/Helper', true), 'ELECTRON_RUN_AS_NODE=1 "/Applications/Code.app/Helper"');
        assert.equal(nodeCommandForGit('C:\\node\\node.exe', false), '"C:/node/node.exe"');
        const line = driverCommandLine('ai-trail', '/ext/out/utils/aiMergeDriverCli.js', '"/n"');
        assert.equal(line, '"/n" "/ext/out/utils/aiMergeDriverCli.js" ai-trail %O %A %B %L %P');
        assert.equal(classifyDriverCommand(undefined, line), 'missing');
        assert.equal(classifyDriverCommand(line, line), 'current');
        assert.equal(classifyDriverCommand('"/n" "/old/out/utils/aiMergeDriverCli.js" ai-trail %O %A %B %L %P', line), 'outdated');
        assert.equal(classifyDriverCommand('python3 "/x/ai_merge_trail.py" %O %A %B %L %P', line), 'other');
    });

    test('MS-2: a fresh _ai, registered and bound', () => {
        const ai = path.join(SANDBOX, 'ws1', '_ai');
        fs.mkdirSync(path.join(ai, 'quests'), { recursive: true });
        let r = checkAiMergeDrivers(ai, opts);
        assert.equal(r.repoRoot, undefined);
        assert.deepEqual(r.drivers.map((d) => d.state), ['missing', 'missing', 'missing', 'missing', 'missing']);
        assert.deepEqual(r.unboundDrivers, AI_MERGE_DRIVER_NAMES);
        assert.throws(() => installAiMergeDrivers(ai, 'local', opts), /in no git repository/);
        git(ai, 'init', '-q');
        const done = setUpAiMergeDrivers(ai, 'local', opts);
        assert.deepEqual(done.drivers, AI_MERGE_DRIVER_NAMES);
        assert.equal(done.bound.length, 11);
        r = checkAiMergeDrivers(ai, opts);
        assert.equal(r.repoRoot && fs.realpathSync(r.repoRoot), fs.realpathSync(ai));
        assert.deepEqual(r.drivers.map((d) => [d.state, d.scope]), AI_MERGE_DRIVER_NAMES.map(() => ['current', 'local']));
        assert.deepEqual(r.unboundDrivers, []);
        assert.equal(r.ok, true);
        const attrs = fs.readFileSync(path.join(ai, '.gitattributes'), 'utf8');
        assert.match(attrs, /^quests\/\*\/history\/sessions\/\*\/live-trail\.md {2}merge=ai-trail$/m);
        assert.match(attrs, /^quests\/\*\/todos\*\.todo\.yaml {2}merge=ai-yaml-smart$/m);
        assert.equal(git(ai, 'config', '--local', '--get', 'merge.ai-yaml-smart.name').trim(), 'AI state YAML smart merge');
        assert.deepEqual(setUpAiMergeDrivers(ai, 'local', opts).bound, [], 'nothing bound twice');
        assert.equal(fs.readFileSync(path.join(ai, '.gitattributes'), 'utf8'), attrs);
    });

    test('MS-3: the upgrade check', () => {
        const ai = path.join(SANDBOX, 'ws1', '_ai');
        git(ai, 'config', '--local', 'merge.ai-trail.driver', driverCommandLine('ai-trail', '/old/ext/out/utils/aiMergeDriverCli.js', NODE));
        let r = checkAiMergeDrivers(ai, opts);
        assert.equal(r.drivers.find((d) => d.driver === 'ai-trail')!.state, 'outdated');
        assert.equal(r.ok, false);
        assert.deepEqual(outdatedDriverUpdate(r), { scope: 'local', drivers: ['ai-trail'] });
        installAiMergeDrivers(ai, 'local', { ...opts, only: ['ai-trail'] });
        r = checkAiMergeDrivers(ai, opts);
        assert.equal(r.ok, true);
        assert.equal(outdatedDriverUpdate(r), undefined);
        // The Python drivers (set globally, as the al_the_bear skills do) are another tool's.
        const other = path.join(SANDBOX, 'ws2', '_ai');
        fs.mkdirSync(other, { recursive: true });
        git(other, 'init', '-q');
        git(other, 'config', '--global', 'merge.ai-trail.driver', 'python3 "/x/ai_merge_trail.py" %O %A %B %L %P');
        git(other, 'config', '--global', 'merge.ai-yaml-smart.driver', driverCommandLine('ai-yaml-smart', '/old/out/utils/aiMergeDriverCli.js', NODE));
        r = checkAiMergeDrivers(other, opts);
        assert.deepEqual(r.drivers.find((d) => d.driver === 'ai-trail'), { driver: 'ai-trail', state: 'other', command: 'python3 "/x/ai_merge_trail.py" %O %A %B %L %P', scope: 'global' });
        assert.deepEqual(outdatedDriverUpdate(r), { scope: 'global', drivers: ['ai-yaml-smart'] });
        git(other, 'config', '--global', '--unset', 'merge.ai-trail.driver');
        git(other, 'config', '--global', '--unset', 'merge.ai-yaml-smart.driver');
    });

    test('MS-4: git merges with them', () => {
        const ai = path.join(SANDBOX, 'ws1', '_ai');
        const trailFile = path.join(ai, 'quests', 'q1', 'history', 'sessions', 'default', 'live-trail.md');
        const todoFile = path.join(ai, 'quests', 'q1', 'todos.q1.todo.yaml');
        fs.mkdirSync(path.dirname(trailFile), { recursive: true });
        const entry = (ts: string, b: string): string => `\n## \u{1F680} PROMPT ${ts} x\n\n${b}\n`;
        fs.writeFileSync(trailFile, '<!-- tom-ai live-trail -->\n' + entry('20261117_100000', 'base'));
        fs.writeFileSync(todoFile, 'todos:\n  - id: base\n    title: base\n');
        git(ai, 'add', '-A');
        git(ai, 'commit', '-qm', 'base');
        git(ai, 'checkout', '-qb', 'other');
        fs.appendFileSync(trailFile, entry('20261117_120000', 'theirsentry'));
        fs.appendFileSync(todoFile, '  - id: theirsentry\n    title: theirs\n');
        git(ai, 'commit', '-qam', 'theirs');
        git(ai, 'checkout', '-q', 'main');
        fs.appendFileSync(trailFile, entry('20261117_110000', 'oursentry'));
        fs.appendFileSync(todoFile, '  - id: oursentry\n    title: ours\n');
        git(ai, 'commit', '-qam', 'ours');
        git(ai, 'merge', '-q', '--no-edit', 'other');
        const trail = fs.readFileSync(trailFile, 'utf8');
        assert.ok(trail.indexOf('base') < trail.indexOf('oursentry') && trail.indexOf('oursentry') < trail.indexOf('theirsentry'), trail);
        assert.ok(!trail.includes('<<<<<<<'));
        const todos = fs.readFileSync(todoFile, 'utf8');
        for (const id of ['base', 'oursentry', 'theirsentry']) { assert.match(todos, new RegExp(`id: ${id}`)); }
    });

    test('MS-5: _ai a folder of a larger repository', () => {
        const ws = path.join(SANDBOX, 'ws3');
        const ai = path.join(ws, '_ai');
        fs.mkdirSync(ai, { recursive: true });
        git(ws, 'init', '-q');
        const done = setUpAiMergeDrivers(ai, 'local', opts);
        assert.equal(done.bound.length, 11);
        assert.equal(fs.existsSync(path.join(ws, '.gitattributes')), false, 'the rules go to _ai/.gitattributes');
        assert.match(git(ws, 'check-attr', 'merge', '--', '_ai/quests/q/live-trail.md'), /merge: ai-trail/);
        assert.equal(checkAiMergeDrivers(ai, opts).ok, true);
    });
});
