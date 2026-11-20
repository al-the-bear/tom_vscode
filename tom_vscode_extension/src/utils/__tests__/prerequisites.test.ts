/**
 * prerequisites.yaml (src/utils/prerequisites.ts, src/utils/prerequisitesTree.ts,
 * src/services/prerequisitesService.ts, src/config/prerequisites.schema.json).
 *
 *   PR-1 parsing: a full file (sections, secrets with every field, tools, defaults); structural problems listed
 *        and the bad entry left out (unknown type, `other` without typeNote, a via without its fields, ids used
 *        twice, no options); not YAML / no sections refused; the skeleton parses
 *   PR-2 the schema: the extension's own prerequisites.yaml, the skeleton and the guideline's example validate;
 *        a wrong type, a via without its field, an unknown key, `other` without typeNote are refused
 *   PR-3 every check with fakes, presence only: env (VS Code and the login shell, two marks, the warnings),
 *        dotenv, file (empty, mode warning), keychain (macOS, Windows, Linux — stdout never asked for on Linux),
 *        vscode_secret, cli_login (gh, gcloud needing an account, dart pub's credentials file, an unknown tool),
 *        ssh_agent (any key, a fingerprint), kdbx / cloud / other unknown, a custom check (exit code, timeout),
 *        a tool (PATH, login shell, its own check); paths with ~ and relative to the file
 *   PR-4 roll-up: a secret is set when any option is, missing when all are; required items decide a level;
 *        optional ones only count; levels combine; the tree groups repository → file → section → item with
 *        the cached results, the repository's own file first, the projects without a file apart
 *   PR-5 discovery and running: the repository of a project (nearest .git), project and repository files,
 *        projects without one; the checks of one program run one at a time, different programs side by side;
 *        a throwing check is unknown; the login-shell probe asks presence only and refuses shell syntax
 *   PR-6 opening at an entry: the line of a section and of an item, a tool, an unknown id
 */

/* eslint-disable @typescript-eslint/naming-convention -- the format's own names (via values, tool names, env names, paths) */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';

import {
    checkOption, checkProgram, checkTool, combineRollUps, dotenvHasKey, onPath, optionKey, parsePrerequisites,
    prerequisitesLineOf, prerequisitesSkeleton, resolveOptionPath, rollUp, secretStatus, toolKey,
    type CheckStatus, type PrerequisiteCheckDeps, type RunResult,
} from '../prerequisites';
import { buildPrerequisitesTree, optionLabel, type DiscoveredFile } from '../prerequisitesTree';
import { discoverPrerequisites, pendingChecks, repositoryOf, runChecks, shellProbeScript, shellQuestions } from '../../services/prerequisitesService';
import { guidelinePath } from './_layoutRoot.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SAMPLE = `formatVersion: 1
sections:
  - id: server
    title: The API server
    description: What the server needs.
    secrets:
      - id: anthropic
        title: Anthropic API key
        type: api_key
        description: For the model calls.
        obtain: console.anthropic.com
        options:
          - via: env
            name: ANTHROPIC_API_KEY
            description: shell profile
          - via: file
            path: ~/.config/anthropic/key
      - id: db
        title: Database URL
        type: connection_string
        required: false
        options:
          - via: dotenv
            file: .env
            name: DATABASE_URL
    tools:
      - id: dart
        title: Dart
        command: dart
  - id: deploy
    title: Deploying
    secrets:
      - id: gh
        title: GitHub login
        type: other
        typeNote: the gh CLI's login
        options:
          - via: cli_login
            tool: gh
`;

function fakeDeps(over: Partial<PrerequisiteCheckDeps> & { runs?: Array<{ command: string; args: string[]; captureStdout?: boolean }> } = {}): PrerequisiteCheckDeps & { runs: Array<{ command: string; args: string[]; captureStdout?: boolean }> } {
    const runs = over.runs ?? [];
    return {
        platform: 'darwin',
        homedir: '/home/u',
        env: {},
        shellHasEnv: async () => 'missing',
        shellHasCommand: async () => 'missing',
        stat: () => null,
        readText: () => null,
        run: async (command, args, opts) => { runs.push({ command, args, captureStdout: opts?.captureStdout }); return { exitCode: 0 }; },
        runShell: async () => ({ exitCode: 0 }),
        vscodeSecretHas: async () => false,
        now: () => new Date('2026-11-17T12:00:00.000Z'),
        ...over,
        runs,
    } as PrerequisiteCheckDeps & { runs: Array<{ command: string; args: string[]; captureStdout?: boolean }> };
}

describe('prerequisites.yaml', () => {
    test('PR-1: parsing', () => {
        const r = parsePrerequisites(SAMPLE);
        assert.ok(r.ok);
        if (!r.ok) { return; }
        assert.deepEqual(r.problems, []);
        assert.deepEqual(r.file.sections.map((s) => s.id), ['server', 'deploy']);
        const [anthropic, db] = r.file.sections[0].secrets;
        assert.deepEqual([anthropic.required, anthropic.type, anthropic.options.length, anthropic.options[0]], [true, 'api_key', 2, { via: 'env', name: 'ANTHROPIC_API_KEY', description: 'shell profile' }]);
        assert.equal(db.required, false, 'required: false kept');
        assert.deepEqual(r.file.sections[0].tools, [{ id: 'dart', title: 'Dart', command: 'dart', required: true, description: undefined, obtain: undefined, check: undefined }]);
        assert.equal(r.file.sections[1].secrets[0].typeNote, 'the gh CLI\'s login');
        assert.deepEqual(r.file.sections[1].tools, [], 'no tools: an empty list');

        const bad = parsePrerequisites(`formatVersion: 2
sections:
  - id: a
    title: A
    secrets:
      - { id: x, title: X, type: nonsense, options: [{ via: env, name: X }] }
      - { id: y, title: Y, type: other, options: [{ via: env, name: Y }] }
      - { id: z, title: Z, type: password, options: [{ via: env }, { via: file, path: k }] }
      - { id: z, title: Z2, type: password, options: [{ via: env, name: Z }] }
      - { id: w, title: W, type: password, options: [] }
    tools:
      - { id: t, title: T }
  - id: a
    title: again
`);
        assert.ok(bad.ok);
        if (!bad.ok) { return; }
        const msgs = bad.problems.map((p) => `${p.path}: ${p.message}`);
        assert.ok(msgs.some((m) => m.startsWith('formatVersion')));
        assert.ok(msgs.some((m) => m.startsWith('sections[0].secrets[0].type')), 'unknown type');
        assert.ok(msgs.some((m) => m.startsWith('sections[0].secrets[1].typeNote')), 'other without typeNote');
        assert.ok(msgs.some((m) => m === 'sections[0].secrets[2].options[0]: via env needs name'), 'a via without its field');
        assert.ok(msgs.some((m) => m.includes('id z is used twice')), 'an id twice');
        assert.ok(msgs.some((m) => m.startsWith('sections[0].secrets[4].options')), 'no options');
        assert.ok(msgs.some((m) => m.startsWith('sections[0].tools[0]')), 'a tool without command');
        assert.ok(msgs.some((m) => m.includes('section id a is used twice')));
        const kept = bad.file.sections[0].secrets.map((s) => s.id);
        assert.deepEqual(kept, ['y', 'z'], 'the usable entries stay; z keeps its one good option');
        assert.deepEqual(bad.file.sections[0].secrets[1].options, [{ via: 'file', path: 'k' }]);

        assert.equal(parsePrerequisites('a: [').ok, false, 'not YAML');
        assert.equal(parsePrerequisites('formatVersion: 1\n').ok, false, 'no sections');
        assert.equal(parsePrerequisites('- 1\n').ok, false, 'not a mapping');
        const skeleton = parsePrerequisites(prerequisitesSkeleton('my_app'));
        assert.ok(skeleton.ok && skeleton.problems.length === 0 && skeleton.file.sections[0].title === 'my_app');
    });

    test('PR-2: the schema', () => {
        const schema = JSON.parse(fs.readFileSync(path.join(EXT, 'src', 'config', 'prerequisites.schema.json'), 'utf8'));
        const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
        const ok = (text: string, what: string): void => { assert.ok(validate(parseYaml(text)), `${what}: ${JSON.stringify(validate.errors)}`); };
        const no = (text: string, what: string): void => { assert.equal(validate(parseYaml(text)), false, what); };
        ok(SAMPLE, 'the sample');
        ok(fs.readFileSync(path.join(EXT, 'prerequisites.yaml'), 'utf8'), 'the extension\'s own file');
        ok(prerequisitesSkeleton('x'), 'the skeleton');
        // The guideline on its two levels (the workspace folder's, then the root's), wherever the layout keeps it.
        const guideline = fs.readFileSync(guidelinePath('prerequisites_yaml.md'), 'utf8');
        const example = /```yaml\n([\s\S]*?)```/.exec(guideline);
        assert.ok(example, 'the guideline has an example');
        ok(example![1], 'the guideline\'s example');
        no(SAMPLE.replace('type: api_key', 'type: apikey'), 'an unknown type');
        no(SAMPLE.replace('            name: ANTHROPIC_API_KEY\n', ''), 'env without name');
        no(SAMPLE.replace('        typeNote: the gh CLI\'s login\n', ''), 'other without typeNote');
        no(SAMPLE.replace('    title: Deploying\n', '    title: Deploying\n    colour: red\n'), 'an unknown key');
        no(SAMPLE.replace('formatVersion: 1', 'formatVersion: 3'), 'another format version');
        // The YAML editor checks the file through the schema.
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        assert.ok(pkg.contributes.yamlValidation.some((v: { fileMatch: string; url: string }) => v.fileMatch === 'prerequisites.yaml' && v.url === './out/config/prerequisites.schema.json'));
    });

    test('PR-3: the checks, presence only', async () => {
        const base = '/ws/proj';
        // env: VS Code and the login shell.
        const env = { via: 'env' as const, name: 'K' };
        let r = await checkOption(env, base, fakeDeps({ env: { K: 'v' }, shellHasEnv: async () => 'set' }));
        assert.deepEqual([r.status, r.host, r.shell, r.warning, r.checkedAt], ['set', 'set', 'set', undefined, '2026-11-17T12:00:00.000Z']);
        assert.ok(!r.detail.includes('v '), 'never the value');
        r = await checkOption(env, base, fakeDeps({ env: { K: 'v' } }));
        assert.deepEqual([r.status, r.host, r.shell], ['set', 'set', 'missing']);
        assert.match(r.warning!, /a terminal will not have it/);
        r = await checkOption(env, base, fakeDeps({ env: { K: '' }, shellHasEnv: async () => 'set' }));
        assert.deepEqual([r.status, r.host, r.shell], ['set', 'missing', 'set'], 'empty is not set; the shell has it');
        assert.match(r.warning!, /not in VS Code/);
        r = await checkOption(env, base, fakeDeps({}));
        assert.equal(r.status, 'missing');
        r = await checkOption(env, base, fakeDeps({ shellHasEnv: async () => 'unknown' }));
        assert.equal(r.status, 'unknown', 'no login shell to ask');

        // dotenv
        const files: Record<string, string> = { '/ws/proj/.env': '# c\nexport A="x"\nB=\nC=\'\'\n' };
        const read = (f: string): string | null => files[f] ?? null;
        assert.equal((await checkOption({ via: 'dotenv', file: '.env', name: 'A' }, base, fakeDeps({ readText: read }))).status, 'set');
        assert.equal((await checkOption({ via: 'dotenv', file: '.env', name: 'B' }, base, fakeDeps({ readText: read }))).status, 'missing');
        assert.equal((await checkOption({ via: 'dotenv', file: '.env', name: 'C' }, base, fakeDeps({ readText: read }))).status, 'missing', 'quotes around nothing');
        assert.equal((await checkOption({ via: 'dotenv', file: 'none', name: 'A' }, base, fakeDeps({ readText: read }))).status, 'missing');
        assert.equal(dotenvHasKey('A = 1', 'A'), true);

        // file
        const stat = (mode: number, size = 10) => (f: string) => (f === '/home/u/.k' ? { size, mode, isFile: true } : null);
        r = await checkOption({ via: 'file', path: '~/.k' }, base, fakeDeps({ stat: stat(0o100600) }));
        assert.deepEqual([r.status, r.warning], ['set', undefined]);
        r = await checkOption({ via: 'file', path: '~/.k' }, base, fakeDeps({ stat: stat(0o100644) }));
        assert.match(r.warning!, /others .*644.*chmod 600/);
        r = await checkOption({ via: 'file', path: '~/.k' }, base, fakeDeps({ stat: stat(0o100640) }));
        assert.match(r.warning!, /the group/);
        assert.equal((await checkOption({ via: 'file', path: '~/.k' }, base, fakeDeps({ stat: stat(0o100644), platform: 'win32' }))).warning, undefined, 'no mode on Windows');
        assert.equal((await checkOption({ via: 'file', path: '~/.k' }, base, fakeDeps({ stat: stat(0o100600, 0) }))).status, 'missing', 'empty');
        assert.equal((await checkOption({ via: 'file', path: 'nope' }, base, fakeDeps({}))).status, 'missing');
        assert.equal(resolveOptionPath('k', base, '/h'), '/ws/proj/k');
        assert.equal(resolveOptionPath('/abs', base, '/h'), '/abs');

        // keychain
        let d = fakeDeps({});
        r = await checkOption({ via: 'keychain', service: 'svc', account: 'me' }, base, d);
        assert.deepEqual(d.runs, [{ command: 'security', args: ['find-generic-password', '-s', 'svc', '-a', 'me'], captureStdout: undefined }], 'no -w: the password is not printed');
        assert.equal(r.status, 'set');
        d = fakeDeps({ run: async () => ({ exitCode: 44 }) });
        assert.equal((await checkOption({ via: 'keychain', service: 'svc' }, base, d)).status, 'missing');
        d = fakeDeps({ platform: 'win32', run: async (_c, args) => ({ exitCode: 0, stdout: args[0] === '/list:t' ? 'Target: t\n' : '* NONE *' }) });
        assert.equal((await checkOption({ via: 'keychain', service: 's', target: 't' }, base, d)).status, 'set');
        assert.equal((await checkOption({ via: 'keychain', service: 's' }, base, d)).status, 'missing');
        d = fakeDeps({ platform: 'linux' });
        await checkOption({ via: 'keychain', service: 'svc', account: 'me' }, base, d);
        assert.deepEqual(d.runs, [{ command: 'secret-tool', args: ['lookup', 'service', 'svc', 'account', 'me'], captureStdout: undefined }], 'its stdout (the secret) is never captured');

        // vscode_secret
        assert.equal((await checkOption({ via: 'vscode_secret', key: 'k' }, base, fakeDeps({ vscodeSecretHas: async (k) => k === 'k' }))).status, 'set');
        assert.equal((await checkOption({ via: 'vscode_secret', key: 'x' }, base, fakeDeps({ vscodeSecretHas: async (k) => k === 'k' }))).status, 'missing');

        // cli_login
        d = fakeDeps({});
        assert.equal((await checkOption({ via: 'cli_login', tool: 'gh' }, base, d)).status, 'set');
        assert.deepEqual(d.runs[0], { command: 'gh', args: ['auth', 'status'], captureStdout: undefined });
        assert.equal((await checkOption({ via: 'cli_login', tool: 'gcloud' }, base, fakeDeps({ run: async () => ({ exitCode: 0, stdout: '' }) }))).status, 'missing', 'gcloud: no active account');
        assert.equal((await checkOption({ via: 'cli_login', tool: 'gcloud' }, base, fakeDeps({ run: async () => ({ exitCode: 0, stdout: 'me@x\n' }) }))).status, 'set');
        assert.equal((await checkOption({ via: 'cli_login', tool: 'npm' }, base, fakeDeps({ run: async () => ({ exitCode: 1 }) }))).status, 'missing');
        const pubCred = '/home/u/Library/Application Support/dart/pub-credentials.json';
        assert.equal((await checkOption({ via: 'cli_login', tool: 'dart pub' }, base, fakeDeps({ stat: (f) => (f === pubCred ? { size: 5, mode: 0o100600, isFile: true } : null) }))).status, 'set');
        assert.equal((await checkOption({ via: 'cli_login', tool: 'dart pub' }, base, fakeDeps({}))).status, 'missing');
        assert.equal((await checkOption({ via: 'cli_login', tool: 'heroku' }, base, fakeDeps({}))).status, 'unknown', 'no built-in check');

        // ssh_agent
        const agent = (stdout: string, exitCode = 0) => fakeDeps({ run: async () => ({ exitCode, stdout }) });
        assert.equal((await checkOption({ via: 'ssh_agent' }, base, agent('256 SHA256:abc me (ED25519)\n'))).status, 'set');
        assert.equal((await checkOption({ via: 'ssh_agent' }, base, agent('The agent has no identities.\n', 1))).status, 'missing');
        assert.equal((await checkOption({ via: 'ssh_agent', fingerprint: 'SHA256:abc' }, base, agent('256 SHA256:abc me (ED25519)\n'))).status, 'set');
        assert.equal((await checkOption({ via: 'ssh_agent', fingerprint: 'SHA256:zzz' }, base, agent('256 SHA256:abc me (ED25519)\n'))).status, 'missing');

        // not checkable from VS Code, unless a check is given
        for (const o of [{ via: 'kdbx' as const, database: 'd', entry: 'e' }, { via: 'cloud_secret_manager' as const, provider: 'aws', name: 'n' }, { via: 'other' as const, viaNote: 'x' }]) {
            assert.equal((await checkOption(o, base, fakeDeps({}))).status, 'unknown', o.via);
        }
        let shellAt = '';
        const custom = fakeDeps({ runShell: async (_l, cwd) => { shellAt = cwd; return { exitCode: 0 }; } });
        assert.equal((await checkOption({ via: 'kdbx', database: 'd', entry: 'e', check: 'tsm has x' }, base, custom)).status, 'set');
        assert.equal(shellAt, base, 'run in the file\'s folder');
        assert.equal((await checkOption({ via: 'env', name: 'K', check: 'false' }, base, fakeDeps({ env: { K: 'v' }, runShell: async () => ({ exitCode: 1 }) }))).status, 'missing', 'the check overrides the built-in');
        assert.equal((await checkOption({ via: 'other', viaNote: 'x', check: 'slow' }, base, fakeDeps({ runShell: async (): Promise<RunResult> => ({ exitCode: null, timedOut: true }) }))).detail.endsWith('timed out'), true);
        assert.equal((await checkOption({ via: 'ssh_agent' }, base, fakeDeps({ run: async (): Promise<RunResult> => ({ exitCode: null, timedOut: true }) }))).status, 'unknown', 'a timeout is unknown');

        // tools
        const tool = { id: 'dart', title: 'Dart', command: 'dart', required: true };
        let t = await checkTool(tool, base, fakeDeps({ shellHasCommand: async () => 'set' }), () => true);
        assert.deepEqual([t.status, t.host, t.shell, t.warning], ['set', 'set', 'set', undefined]);
        t = await checkTool(tool, base, fakeDeps({ shellHasCommand: async () => 'set' }), () => false);
        assert.deepEqual([t.status, t.host, t.shell], ['set', 'missing', 'set']);
        assert.match(t.warning!, /not on VS Code's PATH/);
        t = await checkTool(tool, base, fakeDeps({}), () => false);
        assert.equal(t.status, 'missing');
        t = await checkTool({ ...tool, check: 'dart --version' }, base, fakeDeps({ runShell: async () => ({ exitCode: 0 }) }), () => false);
        assert.equal(t.status, 'set', 'its own check');
        const bin = { '/b/dart': { size: 1, mode: 0o100755, isFile: true }, '/c/dart': { size: 1, mode: 0o100644, isFile: true } } as Record<string, { size: number; mode: number; isFile: boolean }>;
        const st = (f: string) => bin[f] ?? null;
        assert.equal(onPath('dart', '/a:/b', 'darwin', st), true);
        assert.equal(onPath('dart', '/a:/c', 'darwin', st), false, 'not executable');
        assert.equal(onPath('dart', undefined, 'darwin', st), false);

        // The programs a check runs.
        assert.equal(checkProgram({ via: 'keychain', service: 's' }, 'darwin'), 'security');
        assert.equal(checkProgram({ via: 'keychain', service: 's' }, 'linux'), 'secret-tool');
        assert.equal(checkProgram({ via: 'cli_login', tool: 'gh' }, 'darwin'), 'gh');
        assert.equal(checkProgram({ via: 'cli_login', tool: 'dart pub' }, 'darwin'), null, 'a file check runs no program');
        assert.equal(checkProgram({ via: 'env', name: 'X', check: 'x' }, 'darwin'), 'shell');
        assert.equal(checkProgram({ via: 'env', name: 'X' }, 'darwin'), null);
    });

    test('PR-4: roll-up and the tree', () => {
        const res = (status: CheckStatus) => ({ status, detail: '', checkedAt: 'x' });
        assert.equal(secretStatus([res('missing'), res('set')]), 'set');
        assert.equal(secretStatus([res('missing'), res('missing')]), 'missing');
        assert.equal(secretStatus([res('missing'), res('unknown')]), 'unknown');
        assert.equal(secretStatus([res('missing'), undefined]), 'unknown', 'not checked yet');
        assert.deepEqual(rollUp([{ required: true, status: 'set' }, { required: false, status: 'missing' }]), { status: 'set', set: 1, missing: 0, unknown: 0, total: 2 }, 'an optional item missing does not fail it');
        assert.equal(rollUp([{ required: true, status: 'set' }, { required: true, status: 'unknown' }]).status, 'unknown');
        assert.equal(rollUp([{ required: true, status: 'missing' }, { required: true, status: 'unknown' }]).status, 'missing');
        assert.equal(rollUp([]).status, 'set');
        assert.deepEqual(combineRollUps([rollUp([{ required: true, status: 'set' }]), rollUp([{ required: true, status: 'missing' }])]), { status: 'missing', set: 1, missing: 1, unknown: 0, total: 2 });

        const parsed = parsePrerequisites(SAMPLE);
        const file = '/ws/repo/app/prerequisites.yaml';
        const files: DiscoveredFile[] = [
            { file, kind: 'project', name: 'app', dir: '/ws/repo/app', repoDir: '/ws/repo', parsed },
            { file: '/ws/repo/prerequisites.yaml', kind: 'repository', name: 'repo (repository)', dir: '/ws/repo', repoDir: '/ws/repo', parsed: { ok: false, error: 'not YAML', problems: [] } },
            { file: '/ws/other/prerequisites.yaml', kind: 'project', name: 'other', dir: '/ws/other', repoDir: '/ws/other', parsed: parsePrerequisites(prerequisitesSkeleton('other')) },
        ];
        const results = {
            [optionKey(file, 'server', 'anthropic', 0, 'env')]: res('missing'),
            [optionKey(file, 'server', 'anthropic', 1, 'file')]: res('set'),
            [optionKey(file, 'deploy', 'gh', 0, 'cli_login')]: res('missing'),
            [toolKey(file, 'server', 'dart')]: res('set'),
        };
        const tree = buildPrerequisitesTree(files, [{ name: 'lib', dir: '/ws/repo/lib', repoDir: '/ws/repo' }], results, '/ws');
        assert.deepEqual(tree.repositories.map((r) => [r.name, r.relDir, r.files.map((f) => f.kind)]), [['other', 'other', ['project']], ['repo', 'repo', ['repository', 'project']]]);
        const app = tree.repositories[1].files[1];
        assert.equal(tree.repositories[1].files[0].error, 'not YAML');
        const server = app.sections[0];
        assert.deepEqual(server.items.map((i) => [i.nodeId, i.kind, i.status]), [['server/anthropic', 'secret', 'set'], ['server/db', 'secret', 'unknown'], ['server/tool:dart', 'tool', 'set']]);
        assert.deepEqual(server.rollup, { status: 'set', set: 2, missing: 0, unknown: 0, total: 3 }, 'the optional db is not checked and does not count');
        assert.equal(app.sections[1].rollup.status, 'missing');
        assert.equal(app.rollup.status, 'missing');
        assert.equal(tree.repositories[1].rollup.status, 'missing');
        assert.equal(server.items[0].options[0].label, 'env ANTHROPIC_API_KEY');
        assert.deepEqual(server.items[0].options[0].fields, { name: 'ANTHROPIC_API_KEY' });
        assert.equal(tree.checkCount, 5);
        assert.deepEqual(tree.withoutFile, [{ name: 'lib', dir: '/ws/repo/lib', relDir: 'repo/lib', repoName: 'repo' }]);
        assert.equal(optionLabel({ via: 'keychain', service: 's', account: 'a' }), 'keychain s / a');
        assert.equal(optionLabel({ via: 'ssh_agent' }), 'ssh_agent a key loaded');
    });

    test('PR-5: discovery and running', async () => {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'prereq-'));
        try {
            const repo = path.join(sandbox, 'repo');
            for (const d of ['repo/.git', 'repo/app', 'repo/lib', 'solo/.git']) { fs.mkdirSync(path.join(sandbox, d), { recursive: true }); }
            fs.writeFileSync(path.join(repo, 'prerequisites.yaml'), prerequisitesSkeleton('repo'));
            fs.writeFileSync(path.join(repo, 'app', 'prerequisites.yaml'), SAMPLE);
            fs.writeFileSync(path.join(sandbox, 'solo', 'prerequisites.yaml'), 'a: [');
            assert.equal(repositoryOf(path.join(repo, 'app'), sandbox), repo);
            assert.equal(repositoryOf(path.join(sandbox, 'x', 'y'), sandbox, () => false), sandbox, 'no .git: the workspace root');
            const found = discoverPrerequisites(sandbox, [
                { name: 'app', absolutePath: path.join(repo, 'app') },
                { name: 'lib', absolutePath: path.join(repo, 'lib') },
                { name: 'solo', absolutePath: path.join(sandbox, 'solo') },
            ]);
            assert.deepEqual(found.files.map((f) => [f.name, f.kind, f.parsed.ok]).sort(), [['app', 'project', true], ['repo (repository)', 'repository', true], ['solo', 'project', false]]);
            assert.deepEqual(found.without.map((p) => [p.name, p.repoDir]), [['lib', repo]]);
            assert.equal(found.files.filter((f) => f.kind === 'repository').length, 1, 'solo is its own repository and a project: no second entry');

            const checks = pendingChecks(found.files, 'darwin', '');
            assert.deepEqual(checks.map((c) => c.program).sort((a, b) => String(a).localeCompare(String(b))), ['gh', null, null, null, null]);
            assert.deepEqual(shellQuestions(found.files), { env: ['ANTHROPIC_API_KEY'], cmd: ['dart'] });
        } finally {
            fs.rmSync(sandbox, { recursive: true, force: true });
        }

        // One at a time per program, programs side by side.
        let running: Record<string, number> = {};
        let maxSame = 0;
        let maxAll = 0;
        const work = (program: string | null, key: string) => ({
            key, program,
            run: async (deps: PrerequisiteCheckDeps) => {
                const p = program ?? key;
                running[p] = (running[p] ?? 0) + 1;
                maxSame = Math.max(maxSame, running[p]);
                maxAll = Math.max(maxAll, Object.values(running).reduce((a, b) => a + b, 0));
                await new Promise((r) => setTimeout(r, 5));
                running[p]--;
                if (key === 'boom') { throw new Error('bang'); }
                return { status: 'set' as const, detail: key, checkedAt: deps.now().toISOString() };
            },
        });
        running = {};
        const order: number[] = [];
        const results = await runChecks([work('gh', 'a'), work('gh', 'b'), work('security', 'c'), work(null, 'd'), work('gh', 'boom')], fakeDeps({}), (_k, _r, n) => order.push(n));
        assert.equal(maxSame, 1, 'never two checks of one program at once');
        assert.ok(maxAll > 1, 'different programs side by side');
        assert.deepEqual(order, [1, 2, 3, 4, 5]);
        assert.equal(results.boom.status, 'unknown');
        assert.match(results.boom.detail, /bang/);
        assert.equal(Object.keys(results).length, 5);

        const script = shellProbeScript(['A_KEY', 'bad;rm -rf', '$(x)'], ['dart', 'rm -rf /']);
        assert.equal(script, '[ -n "${A_KEY:-}" ] && echo "env:A_KEY"; command -v dart >/dev/null 2>&1 && echo "cmd:dart"; true', 'presence only; shell syntax refused');
    });

    test('PR-6: opening at an entry', () => {
        const text = SAMPLE;
        const lines = text.split('\n');
        const at = (n: number): string => lines[n].trim();
        assert.equal(at(prerequisitesLineOf(text, 'server')), '- id: server');
        assert.equal(at(prerequisitesLineOf(text, 'server/db')), '- id: db');
        assert.equal(at(prerequisitesLineOf(text, 'deploy/gh')), '- id: gh');
        assert.equal(at(prerequisitesLineOf(text, 'server/tool:dart')), '- id: dart');
        assert.equal(at(prerequisitesLineOf(text, 'server/nope')), '- id: server', 'an unknown item: its section');
        assert.equal(prerequisitesLineOf(text, 'nope'), -1);
    });
});
