/**
 * The `_ai` format migration (src/utils/aiFormatMigration.ts, run by
 * scripts/migrate-ai-formats.cjs): brings every quest to the current formats in
 * one idempotent run, with a dry run that lists every change.
 *
 *   FM-1 a dry run lists the changes and writes nothing
 *   FM-2 applied: the per-quest history files, the trail pair and the quest's live trail move into the
 *        `default` session, the raw trail into its `trail/`, flat quest memory into its memory folder; the
 *        migration marker is written; a second run lists nothing
 *   FM-3 a file the session already has is merged with the reconcile's merge driver (live trail and trail
 *        pair: ai-trail; history.json / history.md / compacted_history.md: the history drivers) and the
 *        legacy copy removed; a failed merge keeps both and is a problem; machine-local scratch
 *        (rawTurns.json, compaction_rounds.json) keeps the newer copy
 *   FM-4 the raw trail: `current_prompt.*` (now written per session) is deleted, `last_request*` stays (it is
 *        written there), a tool result whose number the session already uses gets the next free number
 *   FM-5 a session record stored as `fork-from-base` is rewritten as `per-prompt`
 *   FM-6 a legacy `quest-refresh.yaml` / `quest-refresh.<host>.<quest>.yaml` is folded into that host's
 *        `extension_config.<host>.<quest>.yaml` `questRefresh` section when the section is absent, and removed
 *   FM-7 the legacy `mcpServer` block of the workspace config is folded (without `autoStart`) into every
 *        quest's `extension_config.<quest>.yaml` that exists and has no `mcpServer` section, and removed
 *   FM-8 `blocking` is filled on every live todo that live todos name in `blocked_by`
 *   FM-9 a todo tagged `user-action` without the field gets `user_action: true`
 */

/* eslint-disable @typescript-eslint/naming-convention -- `blocked_by`, `user_action` are the todo schema's keys */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';

import { migrateAiFormats, type MergeDriver } from '../aiFormatMigration';

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-format-'));
    const ai = path.join(root, '_ai');
    const q = path.join(ai, 'quests', 'qa');
    fs.mkdirSync(path.join(q, 'history'), { recursive: true });
    const write = (rel: string, text: string) => {
        const p = path.join(ai, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
        return p;
    };
    const exists = (rel: string) => fs.existsSync(path.join(ai, rel));
    const read = (rel: string) => fs.readFileSync(path.join(ai, rel), 'utf8');
    return { root, ai, write, exists, read };
}

const merges: Array<[MergeDriver, string, string]> = [];
function merge(driver: MergeDriver, target: string, legacy: string): string | undefined {
    merges.push([driver, path.basename(target), path.basename(legacy)]);
    if (fs.readFileSync(legacy, 'utf8').includes('UNMERGEABLE')) { return undefined; }
    return fs.readFileSync(target, 'utf8') + fs.readFileSync(legacy, 'utf8');
}

function run(s: ReturnType<typeof sandbox>, apply: boolean, extra: { workspaceConfigPath?: string } = {}) {
    return migrateAiFormats({ aiRoot: s.ai, hostSlug: 'mbp', apply, merge, ...extra });
}

describe('ai format migration', () => {
    test('FM-1: a dry run writes nothing', () => {
        const s = sandbox();
        s.write('quests/qa/history/history.json', '{}');
        s.write('quests/qa/live-trail.md', 'x');
        const r = run(s, false);
        assert.ok(r.changes.some((c) => c.quest === 'qa' && /history\.json/.test(c.detail)));
        assert.ok(s.exists('quests/qa/history/history.json'));
        assert.equal(s.exists('quests/qa/history/sessions'), false);
    });

    test('FM-2: moved into the default session; idempotent', () => {
        const s = sandbox();
        s.write('quests/qa/history/history.json', '{}');
        s.write('quests/qa/history/compacted_history.md', 'c');
        s.write('quests/qa/history/qa.anthropic.prompts.md', 'p');
        s.write('quests/qa/live-trail.md', 'l');
        s.write('trail/anthropic/qa/20261001_1_request.json', '{}');
        s.write('memory/qa/facts.md', 'f');
        run(s, true);
        for (const rel of ['history.json', 'compacted_history.md', 'qa.anthropic.prompts.md', 'live-trail.md', 'trail/20261001_1_request.json']) {
            assert.ok(s.exists(`quests/qa/history/sessions/default/${rel}`), rel);
        }
        assert.ok(s.exists('memory/qa/default/facts.md'));
        assert.equal(s.exists('quests/qa/live-trail.md'), false);
        assert.ok(s.exists('quests/qa/history/sessions/.storage-version'));
        assert.deepEqual(run(s, false).changes, [], 'nothing left to migrate');
    });

    test('FM-3: merged with the reconcile drivers; failure kept as a problem', () => {
        merges.length = 0;
        const s = sandbox();
        s.write('quests/qa/history/sessions/default/live-trail.md', 'NEW ');
        s.write('quests/qa/live-trail.md', 'OLD');
        s.write('quests/qa/history/sessions/default/history.json', '{"a":1}');
        s.write('quests/qa/history/history.json', 'UNMERGEABLE');
        s.write('quests/qa/history/sessions/default/rawTurns.json', '[1]');
        const old = s.write('quests/qa/history/rawTurns.json', '[0]');
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(old, past, past);
        const r = run(s, true);
        assert.equal(s.read('quests/qa/history/sessions/default/live-trail.md'), 'NEW OLD');
        assert.equal(s.exists('quests/qa/live-trail.md'), false);
        assert.deepEqual(merges.map((m) => m[0]), ['ai-history-json', 'ai-trail']);
        assert.ok(s.exists('quests/qa/history/history.json'), 'a failed merge keeps the legacy file');
        assert.ok(r.problems.some((p) => /history\.json/.test(p.detail)));
        assert.equal(s.read('quests/qa/history/sessions/default/rawTurns.json'), '[1]');
        assert.equal(s.exists('quests/qa/history/rawTurns.json'), false);
    });

    test('FM-4: the raw trail', () => {
        const s = sandbox();
        s.write('trail/anthropic/qa/current_prompt.queue.user.md', 'p');
        s.write('trail/anthropic/qa/last_request.json', '{}');
        s.write('trail/anthropic/qa/tool_results/t1.json', '"legacy"');
        s.write('quests/qa/history/sessions/default/trail/tool_results/t1.json', '"session"');
        s.write('quests/qa/history/sessions/default/trail/tool_results/t2.json', '"session2"');
        run(s, true);
        assert.equal(s.exists('trail/anthropic/qa/current_prompt.queue.user.md'), false);
        assert.ok(s.exists('trail/anthropic/qa/last_request.json'));
        assert.equal(s.read('quests/qa/history/sessions/default/trail/tool_results/t3.json'), '"legacy"');
        assert.equal(s.read('quests/qa/history/sessions/default/trail/tool_results/t1.json'), '"session"');
    });

    test('FM-5: fork-from-base becomes per-prompt', () => {
        const s = sandbox();
        s.write('quests/qa/history/f.session.json', JSON.stringify({ basedOn: 'b', mode: 'fork-from-base' }, null, 2));
        run(s, true);
        assert.equal(JSON.parse(s.read('quests/qa/history/f.session.json')).mode, 'per-prompt');
    });

    test('FM-6: legacy quest-refresh files folded and removed', () => {
        const s = sandbox();
        s.write('quests/qa/quest-refresh.yaml', 'panels:\n  anthropic:\n    count: 2\n');
        s.write('quests/qa/quest-refresh.big.qa.yaml', 'panels:\n  anthropic:\n    count: 5\n');
        s.write('quests/qa/extension_config.big.qa.yaml', 'questRefresh:\n  panels:\n    anthropic:\n      count: 9\n');
        run(s, true);
        assert.equal(parse(s.read('quests/qa/extension_config.mbp.qa.yaml')).questRefresh.panels.anthropic.count, 2);
        assert.equal(parse(s.read('quests/qa/extension_config.big.qa.yaml')).questRefresh.panels.anthropic.count, 9, 'an existing section wins');
        assert.equal(s.exists('quests/qa/quest-refresh.yaml'), false);
        assert.equal(s.exists('quests/qa/quest-refresh.big.qa.yaml'), false);
    });

    test('FM-7: the legacy mcpServer block', () => {
        const s = sandbox();
        s.write('quests/qa/extension_config.qa.yaml', 'telegram:\n  enabled: false\n');
        fs.mkdirSync(path.join(s.ai, 'quests', 'qb'), { recursive: true });
        s.write('quests/qc/extension_config.qc.yaml', 'mcpServer:\n  enabled: false\n');
        const cfg = path.join(s.root, 'tom_vscode_extension.json');
        fs.writeFileSync(cfg, JSON.stringify({ a: 1, mcpServer: { enabled: true, basePort: 19920, autoStart: true } }, null, 4) + '\n');
        run(s, true, { workspaceConfigPath: cfg });
        assert.deepEqual(parse(s.read('quests/qa/extension_config.qa.yaml')).mcpServer, { enabled: true, basePort: 19920 });
        assert.equal(s.exists('quests/qb/extension_config.qb.yaml'), false, 'no config file is created');
        assert.deepEqual(parse(s.read('quests/qc/extension_config.qc.yaml')).mcpServer, { enabled: false });
        const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
        assert.deepEqual(after, { a: 1 });
        assert.match(fs.readFileSync(cfg, 'utf8'), /^\{\n {4}"a"/, 'indentation kept');
    });

    test('FM-8 and FM-9: blocking filled, user_action from the tag', () => {
        const s = sandbox();
        s.write('quests/qa/todos.qa.todo.yaml', [
            'todos:',
            '  - id: b', '    description: b', '    status: not-started',
            '  - id: w', '    description: w', '    status: blocked', '    blocked_by:', '      - b',
            '  - id: u', '    description: u', '    status: not-started', '    tags:', '      - user-action',
            '',
        ].join('\n'));
        const dry = run(s, false);
        assert.ok(dry.changes.some((c) => c.step === 'blocking'));
        run(s, true);
        const todos = parse(s.read('quests/qa/todos.qa.todo.yaml')).todos as Array<Record<string, unknown>>;
        assert.deepEqual(todos.find((t) => t.id === 'b')!.blocking, ['w']);
        assert.equal(todos.find((t) => t.id === 'u')!.user_action, true);
        assert.deepEqual(run(s, false).changes, []);
    });
});
