/**
 * The workspace template (scripts/build-workspace-template.cjs, vsc_setup-2):
 * what a new workspace folder is set up from.
 *
 *   WT-1 built from this workspace: the zip holds exactly the listed sources (the config as genericConfig makes it) (the config, all of
 *        _copilot_guidelines/, CLAUDE.md, .github/copilot-instructions.md, _ai roles / processes / schemas /
 *        prompt / format-version.yaml, the tomai_introduction quest once it exists) plus
 *        .tom/workspace_template.json, each byte for byte; nothing else of _ai; the same bytes twice
 *   WT-2 personal paths: in the introduction quest the files of its use on this machine
 *        (extension_config.<host>.<quest>.yaml, session-todo.*, history/, process-state.*) are left out;
 *        anywhere else they are refused; the quest's own extension_config.<quest>.yaml is packed
 *   WT-3 literal secrets are refused (Anthropic key, GitHub tokens, Telegram bot token), anywhere in a text
 *        file; the command line exits 1 and writes nothing
 *   WT-4 a file outside the list is refused; a missing required source stops the build
 *   WT-5 the config in the zip parses and passes the extension's config schema
 *   WT-6 it ships: both install scripts build it before packaging and copy it beside the VSIX, the VSIX
 *        check requires it, git ignores both copies, the copy beside the VSIX is not packed again
 *   WT-7 the template's config: the issue / test panels' repositories and the command lines emptied, everything
 *        else as in the workspace, whose file is not changed
 *   WT-8 `<!-- workspace-specific -->` blocks are left out of the packed Markdown (CLAUDE.md, its mirror, guidelines);
 *        unbalanced markers refuse the build
 *   WT-9 the left-out files (EXCLUDED_PATHS, __pycache__, .pyc) are not packed; list items and table rows linking to
 *        them are dropped
 *   WT-10 the Active Quests table keeps its header and the rows of the quests the template carries
 *   WT-11 built from this workspace, no relative link in the packed Markdown points outside the template
 *   WT-12 the console Markdown guideline is packed for any Dart workspace: it points at the public package's page
 *        (pub.dev, MIT) and names none of this workspace's packages (`tom_basics_console` stays workspace-specific)
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
// eslint-disable-next-line @typescript-eslint/naming-convention
import Ajv from 'ajv';
import { readZip } from '../zipArchive';

const EXT = path.resolve(__dirname, '..', '..', '..');
const WS = path.resolve(EXT, '..', '..', '..');
const SCRIPT = path.join(EXT, 'scripts', 'build-workspace-template.cjs');
interface Entry { path: string; data: Buffer }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tpl = require(SCRIPT) as {
    SOURCES: Array<{ path: string; kind: 'file' | 'dir'; optional?: boolean; leaveOutUse?: boolean }>; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    QUEST_USE_RULES: RegExp[]; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    TEMPLATE_INFO_PATH: string; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    buildTemplate(ws: string): { ok: true; zip: Buffer; files: string[]; skipped: string[]; leftOut: string[] } | { ok: false; errors: string[] };
    checkTemplate(entries: Entry[]): string[];
    CONFIG_PATH: string; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    genericConfig(data: Buffer): Buffer;
    EXCLUDED_PATHS: Set<string>; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    stripWorkspaceSpecific(text: string, file: string): string;
    dropLinksTo(text: string, file: string, excluded: Set<string>): string;
    activeQuestsFor(text: string, carried: string[]): string;
    templateFileData(file: string, data: Buffer): Buffer;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readCentralDirectory } = require(path.join(EXT, 'scripts', 'check-vsix-contents.cjs')) as { readCentralDirectory(b: Buffer): Array<{ name: string; isSymlink: boolean }> };

const present = fs.existsSync(path.join(WS, '.tom', 'tom_vscode_extension.json')) && fs.existsSync(path.join(WS, '_copilot_guidelines'));
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', '.git', 'node_modules']);

/** Every file under a folder, posix paths relative to `root` (an independent walk). */
function filesUnder(root: string, rel: string): string[] {
    return (fs.readdirSync(path.join(root, rel), { recursive: true }) as string[])
        .map((p) => p.split(path.sep).join('/'))
        .filter((p) => !p.split('/').some((seg) => IGNORED.has(seg)))
        .filter((p) => fs.statSync(path.join(root, rel, p)).isFile())
        .map((p) => `${rel}/${p}`);
}

/** A small workspace with every required source. */
function fakeWorkspace(): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-template-'));
    const put = (rel: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); fs.writeFileSync(path.join(ws, rel), text); };
    put('.tom/tom_vscode_extension.json', '{"anthropic": {"apiKeyEnvVar": "ANTHROPIC_API_KEY"}}\n');
    put('_copilot_guidelines/index.md', '# Index\n');
    put('CLAUDE.md', '# Rules\n');
    put('.github/copilot-instructions.md', '# Rules\n');
    put('_ai/roles/default/role.md', '# Role\n');
    put('.tom/json-schema/roles/role-type.schema.json', '{}\n');
    put('_ai/role-types/coder/role-type.yaml', 'tools:\n  mode: profileDefault\n');
    put('_ai/processes/README.md', '# Processes\n');
    put('_ai/schemas/todo.schema.json', '{}\n');
    put('_ai/prompt/p.md', 'prompt\n');
    put('_ai/format-version.yaml', 'version: 7\n');
    put('_ai/quests/tomai_introduction/overview.tomai_introduction.md', '# Introduction\n');
    put('_ai/quests/tomai_introduction/extension_config.tomai_introduction.yaml', 'telegram: {}\n');
    put('_ai/quests/other/overview.other.md', '# not in the template\n');
    put('_ai/memory/x.md', 'not in the template\n');
    return ws;
}

describe('the workspace template', () => {
    test('WT-1: built from this workspace', { skip: present ? false : 'no workspace around this checkout' }, () => {
        const r = tpl.buildTemplate(WS);
        assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
        const expected = new Set<string>([tpl.TEMPLATE_INFO_PATH]);
        for (const src of tpl.SOURCES) {
            const abs = path.join(WS, src.path);
            if (!fs.existsSync(abs)) { assert.equal(src.optional, true, `${src.path} is required`); continue; }
            for (const f of src.kind === 'dir' ? filesUnder(WS, src.path) : [src.path]) {
                const used = src.leaveOutUse && tpl.QUEST_USE_RULES.some((re) => re.test(f.slice(src.path.length + 1)));
                if (!used && !tpl.EXCLUDED_PATHS.has(f) && !f.split('/').includes('__pycache__') && !f.endsWith('.pyc')) { expected.add(f); }
            }
        }
        const entries = readZip(r.zip);
        assert.deepEqual(entries.map((e) => e.path).sort(), [...expected].sort());
        assert.deepEqual(readCentralDirectory(r.zip).map((e) => e.name).sort(), [...expected].sort(), 'readable by the VSIX check\'s reader too');
        for (const e of entries) {
            if (e.path === tpl.TEMPLATE_INFO_PATH) { continue; }
            const expected = tpl.templateFileData(e.path, fs.readFileSync(path.join(WS, e.path)));
            assert.ok(e.data.equals(expected), `${e.path} byte for byte as templateFileData makes it`);
        }
        assert.ok(entries.every((e) => !e.path.startsWith('_ai/') || /^_ai\/(roles|role-types|processes|schemas|prompt|quests\/tomai_introduction)\/|^_ai\/format-version\.yaml$/.test(e.path)),
            'nothing else of _ai');
        const info = JSON.parse(entries.find((e) => e.path === tpl.TEMPLATE_INFO_PATH)!.data.toString('utf8'));
        assert.equal(info.type, 'dart');
        const again = tpl.buildTemplate(WS) as { zip: Buffer };
        assert.ok(again.zip.equals(r.zip), 'deterministic');
    });

    test('WT-2: personal paths', () => {
        const ws = fakeWorkspace();
        const ok = tpl.buildTemplate(ws);
        assert.ok(ok.ok, ok.ok ? '' : ok.errors.join('\n'));
        const names = readZip((ok as { zip: Buffer }).zip).map((e) => e.path);
        assert.ok(names.includes('_ai/quests/tomai_introduction/extension_config.tomai_introduction.yaml'), 'the quest\'s own config is fine');
        assert.ok(!names.some((n) => n.startsWith('_ai/quests/other/') || n.startsWith('_ai/memory/')), 'other quests and memory are not taken');
        // The introduction quest's use on this machine is left out, not refused.
        const used = fakeWorkspace();
        const usedFiles = [
            '_ai/quests/tomai_introduction/extension_config.my-host.tomai_introduction.yaml',
            '_ai/quests/tomai_introduction/session-todo.my-host.tomai_introduction.todo.yaml',
            '_ai/quests/tomai_introduction/history/sessions/default/live-trail.md',
            '_ai/quests/tomai_introduction/process-state.tomai_introduction.yaml',
        ];
        for (const f of usedFiles) { fs.mkdirSync(path.dirname(path.join(used, f)), { recursive: true }); fs.writeFileSync(path.join(used, f), 'x\n'); }
        const usedBuild = tpl.buildTemplate(used);
        assert.ok(usedBuild.ok, usedBuild.ok ? '' : usedBuild.errors.join('\n'));
        assert.deepEqual((usedBuild as { leftOut: string[] }).leftOut, [...usedFiles].sort());
        const usedNames = readZip((usedBuild as { zip: Buffer }).zip).map((e) => e.path);
        assert.ok(usedFiles.every((f) => !usedNames.includes(f)), 'not in the zip');
        assert.ok(usedNames.includes('_ai/quests/tomai_introduction/overview.tomai_introduction.md'), 'the quest itself is');
        // Anywhere else such a file is refused.
        for (const [planted, why] of [
            ['_ai/processes/extension_config.my-host.tomai_introduction.yaml', /host-specific quest config/],
            ['_ai/roles/session-todo.my-host.x.todo.yaml', /session todo file/],
            ['_copilot_guidelines/history/live-trail.md', /history folder/],
        ] as const) {
            const w = fakeWorkspace();
            fs.mkdirSync(path.dirname(path.join(w, planted)), { recursive: true });
            fs.writeFileSync(path.join(w, planted), 'x\n');
            const r = tpl.buildTemplate(w);
            assert.equal(r.ok, false, planted);
            assert.match((r as { errors: string[] }).errors.join('\n'), why);
        }
    });

    test('WT-3: literal secrets', () => {
        for (const [file, text, why] of [
            ['.tom/tom_vscode_extension.json', '{"anthropic": {"apiKey": "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"}}', /Anthropic API key/],
            ['_copilot_guidelines/index.md', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', /GitHub token \(ghp_/],
            ['CLAUDE.md', 'github_pat_11ABCDEFG0123456789_abcdefghij', /GitHub token \(github_pat_/],
            ['_ai/prompt/p.md', 'bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq', /Telegram bot token/],
        ] as const) {
            const ws = fakeWorkspace();
            fs.writeFileSync(path.join(ws, file), text);
            const r = tpl.buildTemplate(ws);
            assert.equal(r.ok, false, file);
            assert.match((r as { errors: string[] }).errors.join('\n'), why);
        }
        const ws = fakeWorkspace();
        fs.writeFileSync(path.join(ws, 'CLAUDE.md'), 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123');
        const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-template-out-')), 'workspace_template.zip');
        const run = spawnSync(process.execPath, [SCRIPT, '--workspace', ws, '--out', out], { encoding: 'utf8' });
        assert.equal(run.status, 1);
        assert.match(run.stderr, /CLAUDE\.md: contains an Anthropic API key/);
        assert.ok(!fs.existsSync(out), 'nothing written');
        const docs = fakeWorkspace();
        fs.writeFileSync(path.join(docs, 'CLAUDE.md'), 'Keys look like `sk-ant-…`; name the variable, e.g. ANTHROPIC_API_KEY.');
        assert.equal(tpl.buildTemplate(docs).ok, true, 'a mention is not a key');
    });

    test('WT-4: outside the list, missing sources', () => {
        assert.deepEqual(tpl.checkTemplate([{ path: '_ai/memory/x.md', data: Buffer.from('x') }]), ['_ai/memory/x.md: outside the template\'s list']);
        assert.deepEqual(tpl.checkTemplate([{ path: '_ai/roles/default/role.md', data: Buffer.from('x') }]), []);
        const ws = fakeWorkspace();
        fs.rmSync(path.join(ws, 'CLAUDE.md'));
        fs.rmSync(path.join(ws, '_ai', 'quests', 'tomai_introduction'), { recursive: true });
        const r = tpl.buildTemplate(ws);
        assert.equal(r.ok, false);
        assert.deepEqual((r as { errors: string[] }).errors, [`CLAUDE.md: missing in ${ws}`], 'only required sources stop it');
        fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# Rules\n');
        const without = tpl.buildTemplate(ws) as { ok: true; skipped: string[] };
        assert.deepEqual(without.skipped, ['_ai/quests/tomai_introduction'], 'the introduction quest is optional until it exists');
    });

    test('WT-5: the config passes the schema', { skip: present ? false : 'no workspace around this checkout' }, () => {
        const r = tpl.buildTemplate(WS) as { zip: Buffer };
        const config = JSON.parse(readZip(r.zip).find((e) => e.path === '.tom/tom_vscode_extension.json')!.data.toString('utf8'));
        const schema = JSON.parse(fs.readFileSync(path.join(EXT, 'src', 'config', 'tom_vscode_extension.schema.json'), 'utf8'));
        const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
        assert.ok(validate(config), JSON.stringify(validate.errors));
    });

    test('WT-6: it ships', () => {
        const read = (f: string): string => fs.readFileSync(path.join(EXT, f), 'utf8');
        const sh = read('install_extension.sh');
        assert.ok(sh.indexOf('node scripts/build-workspace-template.cjs --copy-to "$SCRIPT_DIR"') > 0);
        assert.ok(sh.indexOf('node scripts/build-workspace-template.cjs') < sh.indexOf('$VSCE_CMD package'), '.sh: before packaging');
        const ps1 = read('install_extension.ps1');
        assert.ok(ps1.indexOf('Invoke-Native { node scripts/build-workspace-template.cjs --copy-to $ExtensionDir }') > 0);
        assert.ok(ps1.indexOf('build-workspace-template.cjs') < ps1.indexOf('cmd /c vsce package'), '.ps1: before packaging');
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/naming-convention
        const { REQUIRED } = require(path.join(EXT, 'scripts', 'check-vsix-contents.cjs')) as { REQUIRED: string[] };
        assert.ok(REQUIRED.includes('extension/resources/workspace_template.zip'));
        const gitignore = read('.gitignore').split('\n');
        assert.ok(gitignore.includes('resources/workspace_template.zip') && gitignore.includes('/workspace_template.zip'));
        const vscodeignore = read('.vscodeignore').split('\n');
        assert.ok(vscodeignore.includes('workspace_template.zip'), 'the copy beside the VSIX is not packed');
        assert.ok(!vscodeignore.some((l) => l.startsWith('resources/')), 'the one in resources/ is');
        assert.match(read('package.json'), /"template:build": "node scripts\/build-workspace-template\.cjs"/);
    });
    test('WT-7: the template config leaves out this workspace\'s repositories and command lines', () => {
        const live = {
            anthropic: { profiles: [{ id: 'p' }] },
            issuePanels: { common: { growthPriority: ['title'] }, issueKit: { additionalRepos: ['Mine:me/repo'], excludeRepos: ['x/y'], provider: 'github' }, testkit: { additionalRepos: ['me/tests'], excludeRepos: [] } },
            commandlines: [{ command: 'git status', cwd: '${workspaceFolder}/mine' }],
            commandlinePostActions: [{ commandId: 'workbench.action.reloadWindow' }],
        };
        const text = JSON.stringify(live, null, 2);
        const out = tpl.genericConfig(Buffer.from(text));
        const generic = JSON.parse(out.toString('utf8'));
        assert.deepEqual(generic.issuePanels.issueKit, { additionalRepos: [], excludeRepos: [], provider: 'github' });
        assert.deepEqual(generic.issuePanels.testkit, { additionalRepos: [], excludeRepos: [] });
        assert.deepEqual(generic.issuePanels.common, live.issuePanels.common, 'everything else stays');
        assert.deepEqual(generic.commandlines, []);
        assert.deepEqual(generic.commandlinePostActions, live.commandlinePostActions);
        assert.deepEqual(generic.anthropic, live.anthropic);
        assert.equal(out.toString('utf8').endsWith('\n'), false, 'the source\'s final newline is kept as it is');
        assert.equal(tpl.genericConfig(Buffer.from(text + '\n')).toString('utf8').endsWith('}\n'), true);
        // In a built template, and the workspace file untouched.
        const ws = fakeWorkspace();
        fs.writeFileSync(path.join(ws, '.tom', 'tom_vscode_extension.json'), text);
        const r = tpl.buildTemplate(ws) as { zip: Buffer };
        const packed = JSON.parse(readZip(r.zip).find((e) => e.path === tpl.CONFIG_PATH)!.data.toString('utf8'));
        assert.deepEqual(packed.commandlines, []);
        assert.equal(fs.readFileSync(path.join(ws, '.tom', 'tom_vscode_extension.json'), 'utf8'), text);
    });
    test('WT-8: workspace-specific blocks are left out', () => {
        const text = '# Rules\n\nGeneric.\n\n<!-- workspace-specific -->\n## This workspace\n\nMine.\n<!-- /workspace-specific -->\n\nAfter.\n';
        assert.equal(tpl.stripWorkspaceSpecific(text, 'CLAUDE.md'), '# Rules\n\nGeneric.\n\nAfter.\n');
        assert.throws(() => tpl.stripWorkspaceSpecific('<!-- workspace-specific -->\nx\n', 'a.md'), /never closed/);
        assert.throws(() => tpl.stripWorkspaceSpecific('x\n<!-- /workspace-specific -->\n', 'a.md'), /without an opening marker/);
        const ws = fakeWorkspace();
        fs.writeFileSync(path.join(ws, 'CLAUDE.md'), text);
        fs.writeFileSync(path.join(ws, '_copilot_guidelines', 'broken.md'), '<!-- workspace-specific -->\nopen\n');
        const refused = tpl.buildTemplate(ws);
        assert.equal(refused.ok, false);
        assert.match((refused as { errors: string[] }).errors.join('\n'), /broken\.md:1: .*never closed/);
        fs.rmSync(path.join(ws, '_copilot_guidelines', 'broken.md'));
        const r = tpl.buildTemplate(ws) as { zip: Buffer };
        assert.equal(readZip(r.zip).find((e) => e.path === 'CLAUDE.md')!.data.toString('utf8'), '# Rules\n\nGeneric.\n\nAfter.\n');
        if (present) {
            const live = tpl.templateFileData('CLAUDE.md', fs.readFileSync(path.join(WS, 'CLAUDE.md'))).toString('utf8');
            assert.doesNotMatch(live, /workspace-specific|tom_build_base|al_the_bear|Multi-repo workflow|Run Dart tests with `testkit`/, 'the live CLAUDE.md packs only its generic part');
            assert.match(live, /## Quick Reference/);
        }
    });

    test('WT-9: left-out files and the links to them', () => {
        const ws = fakeWorkspace();
        const put = (rel: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); fs.writeFileSync(path.join(ws, rel), text); };
        put('_copilot_guidelines/projects_and_repos.md', '# Projects\n');
        put('_copilot_guidelines/workspace_checks.md', '# Checks\n');
        put('_ai/schemas/__pycache__/x.cpython-312.pyc', 'bytes');
        put('_ai/schemas/stray.pyc', 'bytes');
        put('_ai/prompt/bot.chat-history.prompt.md', 'a chat log\n');
        put('_copilot_guidelines/dart/setup.md', '# Setup\n\n- [Projects](../projects_and_repos.md) - ids\n- [Kept](../index.md)\n\n| [workspace_checks.md](../workspace_checks.md) | x |\n\nSee [projects](../projects_and_repos.md) in a paragraph.\n');
        const r = tpl.buildTemplate(ws) as { zip: Buffer };
        const names = readZip(r.zip).map((e) => e.path);
        for (const gone of ['_copilot_guidelines/projects_and_repos.md', '_copilot_guidelines/workspace_checks.md', '_ai/schemas/__pycache__/x.cpython-312.pyc', '_ai/schemas/stray.pyc', '_ai/prompt/bot.chat-history.prompt.md']) {
            assert.ok(!names.includes(gone), gone);
        }
        const setup = readZip(r.zip).find((e) => e.path === '_copilot_guidelines/dart/setup.md')!.data.toString('utf8');
        assert.equal(setup, '# Setup\n\n- [Kept](../index.md)\n\n\nSee [projects](../projects_and_repos.md) in a paragraph.\n', 'list items and table rows dropped; a paragraph is marked by hand');
        assert.ok(names.includes('_ai/prompt/p.md'), 'other prompts packed');
    });

    test('WT-10: the Active Quests table keeps the carried quests', () => {
        const text = '# Quests\n\n## Active Quests\n\n| ID | Name | Description | Path |\n|----|------|-------------|------|\n| mine | Mine | x | `_ai/quests/mine/` |\n| tomai_introduction | Intro | y | `_ai/quests/tomai_introduction/` |\n| other | Other | z | `_ai/quests/other/` |\n\n## Next\n\n| a | b |\n|---|---|\n| keep | me |\n';
        assert.equal(tpl.activeQuestsFor(text, ['tomai_introduction']), '# Quests\n\n## Active Quests\n\n| ID | Name | Description | Path |\n|----|------|-------------|------|\n| tomai_introduction | Intro | y | `_ai/quests/tomai_introduction/` |\n\n## Next\n\n| a | b |\n|---|---|\n| keep | me |\n');
        assert.equal(tpl.activeQuestsFor('# No table\n', ['x']), '# No table\n');
        if (present) {
            const live = tpl.templateFileData('_copilot_guidelines/quests_and_processes.md', fs.readFileSync(path.join(WS, '_copilot_guidelines/quests_and_processes.md'))).toString('utf8');
            const after = live.slice(live.indexOf('## Active Quests')).split('\n').slice(1);
            const start = after.findIndex((l) => l.startsWith('|'));
            const end = after.findIndex((l, k) => k > start && !l.startsWith('|'));
            const rows = after.slice(start + 2, end);
            assert.deepEqual(rows.map((l) => l.split('|')[1].trim()), ['tomai_introduction']);
        }
    });
    test('WT-11: no relative link in the packed Markdown leaves the template', { skip: present ? false : 'no workspace around this checkout' }, () => {
        const entries = readZip((tpl.buildTemplate(WS) as { zip: Buffer }).zip);
        const names = new Set(entries.map((e) => e.path));
        const dirs = new Set<string>();
        for (const n of names) { for (let d = path.posix.dirname(n); d && d !== '.'; d = path.posix.dirname(d)) { dirs.add(d); } }
        const dead: string[] = [];
        for (const e of entries.filter((x) => x.path.endsWith('.md'))) {
            let fence = false;
            e.data.toString('utf8').split('\n').forEach((line, i) => {
                if (/^\s*```/.test(line)) { fence = !fence; return; }
                if (fence) { return; }
                for (const m of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
                    if (/^[a-z]+:/i.test(m[1])) { continue; }
                    const target = path.posix.normalize(path.posix.join(path.posix.dirname(e.path), decodeURI(m[1])));
                    if (!names.has(target) && !dirs.has(target.replace(/\/$/, ''))) { dead.push(`${e.path}:${i + 1}: ${m[1]}`); }
                }
            });
        }
        assert.deepEqual(dead, [], 'mark the passage <!-- workspace-specific --> or leave the file out (EXCLUDED_PATHS)');
    });

    test('WT-12: the console Markdown guideline is generic in the template', { skip: present ? false : 'no workspace around this checkout' }, () => {
        const entries = readZip((tpl.buildTemplate(WS) as { zip: Buffer }).zip);
        const guideline = entries.find((e) => e.path === '_copilot_guidelines/console_markdown.md');
        assert.ok(guideline, 'packed');
        const text = guideline.data.toString('utf8');
        assert.match(text, /\[pub\.dev\]\(https:\/\/pub\.dev\/packages\/console_markdown\)/, 'the syntax: the public package\'s page');
        assert.doesNotMatch(text, /tom_basics_console|tom_ai\//, 'no package of this workspace');
        assert.match(fs.readFileSync(path.join(WS, '_copilot_guidelines', 'console_markdown.md'), 'utf8'),
            /<!-- workspace-specific -->\nIn this workspace the package that formats the console output, `tom_basics_console`/, 'kept in the workspace\'s own copy');
    });
});
