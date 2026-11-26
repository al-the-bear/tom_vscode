/**
 * Format version 11, step `config-files` (src/utils/formatV11/configFiles.ts): every quest's process states and
 * extension configurations into its folder `config/` (ai_format_migration.md § 3.2).
 *
 *   CF-1 a dry run lists every move (the default run's and the runs' process states, the shared and every host's
 *        extension configuration) and every stale temporary file, and writes nothing
 *   CF-2 the run moves them into `config/`, deletes the temporary files and leaves every other file where it is
 *   CF-3 a second run lists nothing
 *   CF-4 a target that exists: identical, the old file goes; with other content, a problem and both stay
 *   CF-5 a `config` that is a file: a problem, nothing moves
 *   CF-6 through migrateAiFormats (format version 11) on a format version 10 quest: the step runs first, so the
 *        older steps (legacy quest-refresh, process state stack, default run, Telegram keys, the mcpServer block,
 *        the removed ask tools) find and write the files in `config/`; their dry run names the files there
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse, stringify } from 'yaml';

import { migrateAiFormats } from '../aiFormatMigration';
import { migrateV11ConfigFiles } from '../formatV11/configFiles';
import type { V11Context, V11Step } from '../formatV11/context';

interface Entry { quest: string; step: V11Step; detail: string }

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-config-'));
    const ai = path.join(root, '_ai');
    fs.mkdirSync(path.join(ai, 'quests'), { recursive: true });
    const write = (rel: string, text: string): string => {
        const p = path.join(ai, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
        return p;
    };
    const exists = (rel: string): boolean => fs.existsSync(path.join(ai, rel));
    const read = (rel: string): string => fs.readFileSync(path.join(ai, rel), 'utf8');
    const step = (apply: boolean): { changes: Entry[]; problems: Entry[] } => {
        const changes: Entry[] = [];
        const problems: Entry[] = [];
        const quests = fs.readdirSync(path.join(ai, 'quests')).sort();
        const ctx: V11Context = {
            aiRoot: ai, hostSlug: 'mbp', apply, quests, allQuests: quests,
            change: (quest, s, detail) => changes.push({ quest, step: s, detail }),
            problem: (quest, s, detail) => problems.push({ quest, step: s, detail }),
            rel: (p) => path.relative(ai, p).split(path.sep).join('/'),
        };
        migrateV11ConfigFiles(ctx);
        return { changes, problems };
    };
    return { root, ai, write, exists, read, step };
}

/** A quest `qa` of format version 10: every file kind of the step, a stale temporary file, and files that stay. */
function v10Quest(s: ReturnType<typeof sandbox>): void {
    s.write('quests/qa/process-state.qa.yaml', 'levels: []\n');
    s.write('quests/qa/process-state.qa.r1.yaml', 'levels:\n  - process: p\n');
    s.write('quests/qa/extension_config.qa.yaml', 'telegram:\n  defaultChatId: 1\n');
    s.write('quests/qa/extension_config.mbp.qa.yaml', 'cliServer:\n  autostart: true\n');
    s.write('quests/qa/extension_config.big.qa.yaml', 'mcpServer:\n  autostart: false\n');
    s.write('quests/qa/.extension_config.qa.yaml.4711.3.tmp', 'half\n');
    s.write('quests/qa/process-state.qa.yaml.tmp', 'half\n');
    s.write('quests/qa/overview.qa.md', '# qa\n');
    s.write('quests/qa/quest-refresh.yaml', 'panels: {}\n');
    s.write('quests/qa/notes/process-state.md', 'a note, not a state\n');
}

const MOVED = ['extension_config.big.qa.yaml', 'extension_config.mbp.qa.yaml', 'extension_config.qa.yaml', 'process-state.qa.r1.yaml', 'process-state.qa.yaml'];

describe('format version 11: config/', () => {
    test('CF-1: a dry run lists, writes nothing', () => {
        const s = sandbox();
        v10Quest(s);
        const { changes, problems } = s.step(false);
        assert.deepEqual(problems, []);
        assert.ok(changes.every((c) => c.quest === 'qa' && c.step === 'config-files'));
        assert.deepEqual(changes.map((c) => c.detail).sort(), [
            ...MOVED.map((f) => `move quests/qa/${f} -> quests/qa/config/${f}`),
            'remove quests/qa/.extension_config.qa.yaml.4711.3.tmp (a temporary file left behind)',
            'remove quests/qa/process-state.qa.yaml.tmp (a temporary file left behind)',
        ].sort());
        assert.equal(s.exists('quests/qa/config'), false);
        for (const f of MOVED) { assert.ok(s.exists(`quests/qa/${f}`), f); }
        assert.ok(s.exists('quests/qa/process-state.qa.yaml.tmp'));
        fs.rmSync(s.root, { recursive: true, force: true });
    });

    test('CF-2 and CF-3: moved, temporary files deleted, the rest stays; a second run lists nothing', () => {
        const s = sandbox();
        v10Quest(s);
        const before = Object.fromEntries(MOVED.map((f) => [f, s.read(`quests/qa/${f}`)]));
        const { problems } = s.step(true);
        assert.deepEqual(problems, []);
        assert.deepEqual(fs.readdirSync(path.join(s.ai, 'quests', 'qa', 'config')).sort(), MOVED);
        for (const f of MOVED) {
            assert.equal(s.read(`quests/qa/config/${f}`), before[f], `${f} byte for byte`);
            assert.equal(s.exists(`quests/qa/${f}`), false, `${f} gone from the top`);
        }
        assert.equal(s.exists('quests/qa/.extension_config.qa.yaml.4711.3.tmp'), false);
        assert.equal(s.exists('quests/qa/process-state.qa.yaml.tmp'), false);
        assert.ok(s.exists('quests/qa/overview.qa.md'));
        assert.ok(s.exists('quests/qa/quest-refresh.yaml'), 'the legacy quest-refresh file is the legacyConfig step\'s');
        assert.ok(s.exists('quests/qa/notes/process-state.md'), 'a file in a subfolder is no config file');
        assert.deepEqual(s.step(true), { changes: [], problems: [] }, 'idempotent');
        assert.deepEqual(s.step(false), { changes: [], problems: [] });
        fs.rmSync(s.root, { recursive: true, force: true });
    });

    test('CF-4: a target that exists', () => {
        const s = sandbox();
        s.write('quests/qa/extension_config.qa.yaml', 'telegram: {}\n');
        s.write('quests/qa/config/extension_config.qa.yaml', 'telegram: {}\n');
        s.write('quests/qa/process-state.qa.yaml', 'levels: []\n');
        s.write('quests/qa/config/process-state.qa.yaml', 'levels:\n  - process: other\n');
        const dry = s.step(false);
        assert.deepEqual(dry.changes.map((c) => c.detail), ['remove quests/qa/extension_config.qa.yaml (identical to quests/qa/config/extension_config.qa.yaml)']);
        assert.equal(dry.problems.length, 1);
        assert.ok(s.exists('quests/qa/extension_config.qa.yaml'), 'a dry run deletes nothing');
        const applied = s.step(true);
        assert.equal(s.exists('quests/qa/extension_config.qa.yaml'), false, 'the identical copy goes');
        assert.equal(applied.problems.length, 1);
        assert.equal(applied.problems[0].step, 'config-files');
        assert.match(applied.problems[0].detail, /^quests\/qa\/process-state\.qa\.yaml: quests\/qa\/config\/process-state\.qa\.yaml exists with other content; both kept/);
        assert.equal(s.read('quests/qa/process-state.qa.yaml'), 'levels: []\n', 'both kept');
        assert.equal(s.read('quests/qa/config/process-state.qa.yaml'), 'levels:\n  - process: other\n');
        assert.deepEqual(s.step(true).changes, [], 'the problem stays a problem, nothing else to do');
        fs.rmSync(s.root, { recursive: true, force: true });
    });

    test('CF-5: a `config` that is a file', () => {
        const s = sandbox();
        s.write('quests/qa/config', 'not a folder\n');
        s.write('quests/qa/extension_config.qa.yaml', 'telegram: {}\n');
        const r = s.step(true);
        assert.deepEqual(r.changes, []);
        assert.match(r.problems[0].detail, /quests\/qa\/config is a file, not a folder/);
        assert.ok(s.exists('quests/qa/extension_config.qa.yaml'));
        fs.rmSync(s.root, { recursive: true, force: true });
    });

    test('CF-6: through migrateAiFormats, before the older steps', () => {
        const s = sandbox();
        s.write('processes/des/des.process.yaml', 'id: des\nname: Design\nphases:\n  - id: p1\n    steps:\n      - id: work\n    gate:\n      id: g1\n');
        // A flat process state naming a process on `default` (format versions 2 and 9 still to do).
        s.write('quests/qa/process-state.qa.yaml', stringify({ process: 'des', phase: 'p1', step: 'work', updated: '2026-11-01T00:00:00.000Z' }));
        s.write('quests/qa/quest-refresh.mbp.qa.yaml', 'panels:\n  anthropic:\n    count: 3\n');
        s.write('quests/qa/extension_config.qa.yaml', 'telegram:\n  defaultChatId: 1\n  notifyOnTurn: true\nmcpServer:\n  enabledTools:\n    - tomAi_readFile\n    - tomAi_askCopilot\n');
        s.write('quests/qb/extension_config.qb.yaml', 'telegram: {}\n');
        const cfg = path.join(s.root, 'tom_vscode_extension.json');
        fs.writeFileSync(cfg, JSON.stringify({ mcpServer: { basePort: 19920 } }, null, 4) + '\n');
        const run = (apply: boolean) => migrateAiFormats({ aiRoot: s.ai, hostSlug: 'mbp', apply, merge: () => undefined, workspaceConfigPath: cfg, formatVersion: 11, today: '2026-11-25' });

        const dry = run(false);
        const details = (step: string) => dry.changes.filter((c) => c.step === step).map((c) => `${c.quest}: ${c.detail}`);
        assert.deepEqual(details('config-files'), [
            'qa: move quests/qa/extension_config.qa.yaml -> quests/qa/config/extension_config.qa.yaml',
            'qa: move quests/qa/process-state.qa.yaml -> quests/qa/config/process-state.qa.yaml',
            'qb: move quests/qb/extension_config.qb.yaml -> quests/qb/config/extension_config.qb.yaml',
        ]);
        assert.equal(dry.changes[0].step, 'config-files', 'the first step of the run');
        assert.deepEqual(details('legacy-config'), [
            'qa: fold quests/qa/quest-refresh.mbp.qa.yaml into quests/qa/config/extension_config.mbp.qa.yaml (questRefresh)',
            'qa: remove quests/qa/quest-refresh.mbp.qa.yaml',
        ]);
        assert.deepEqual(details('process-state'), ['qa: config/process-state.qa.yaml: the position as the one level of a stack']);
        assert.ok(details('default-run').some((d) => d.startsWith('qa: the default run\'s process des -> run des (config/process-state.qa.des.yaml)')), details('default-run').join('\n'));
        assert.deepEqual(details('telegram-settings'), ['qa: quests/qa/config/extension_config.qa.yaml: remove telegram notifyOnTurn']);
        assert.deepEqual(details('mcpServer').filter((d) => d.startsWith('q')), [
            'qb: fold the legacy mcpServer block into quests/qb/config/extension_config.qb.yaml',
        ], 'qa has its mcpServer section already');
        assert.deepEqual(details('removed-ask-tools').filter((d) => d.startsWith('qa')), ['qa: quests/qa/config/extension_config.qa.yaml: remove tomAi_askCopilot / tomAi_askBigBrother, 1 entry']);
        assert.equal(s.exists('quests/qa/config'), false, 'a dry run writes nothing');

        const applied = run(true);
        assert.deepEqual(applied.problems.filter((p) => p.step === 'config-files'), []);
        assert.deepEqual(fs.readdirSync(path.join(s.ai, 'quests', 'qa')).filter((f) => /^(process-state|extension_config|quest-refresh)\./.test(f)), [], 'nothing left at the top');
        assert.deepEqual(fs.readdirSync(path.join(s.ai, 'quests', 'qa', 'config')).sort(), [
            'extension_config.mbp.qa.yaml', 'extension_config.qa.yaml', 'process-state.qa.des.yaml', 'process-state.qa.yaml',
        ]);
        assert.deepEqual(parse(s.read('quests/qa/config/extension_config.mbp.qa.yaml')), { questRefresh: { panels: { anthropic: { count: 3 } } } });
        assert.deepEqual(parse(s.read('quests/qa/config/extension_config.qa.yaml')), { telegram: { defaultChatId: 1 }, mcpServer: { enabledTools: ['tomAi_readFile'] } });
        assert.deepEqual(parse(s.read('quests/qb/config/extension_config.qb.yaml')), { telegram: {}, mcpServer: { basePort: 19920 } });
        const des = parse(s.read('quests/qa/config/process-state.qa.des.yaml'));
        assert.equal(des.levels[0].process, 'des', 'the stack moved into the run');
        assert.equal(parse(s.read('quests/qa/config/process-state.qa.yaml')).movedTo, 'des');

        const again = run(false).changes.filter((c) => ['config-files', 'legacy-config', 'process-state', 'default-run', 'telegram-settings', 'mcpServer', 'removed-ask-tools'].includes(c.step));
        assert.deepEqual(again, [], 'a second run lists nothing of these steps');
        fs.rmSync(s.root, { recursive: true, force: true });
    });
});
