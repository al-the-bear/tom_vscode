/**
 * The `_ai` merge drivers in TypeScript (utils/aiMergeDrivers/, vscimpb142c) against the Python drivers they
 * port (al_the_bear/.claude/skills/_lib/merge_drivers/; found above this checkout, or TOM_AI_MERGE_DRIVERS_DIR).
 *
 *   MP-1 parity: every case run through the Python driver (python3 <driver>.py %O %A %B %L %P) and through
 *        the CLI git runs (aiMergeDriverCli.js): the same exit code and the same %A afterwards, byte for byte —
 *        for ai-yaml-smart the same values as YAML 1.1 reads them (PyYAML rewrites timestamps). The cases: the
 *        fixtures of probe_ai_merge_drivers.py and test_ai_merge_drivers.sh, and the edges each driver names
 *        (empty sides, collisions, code-point lengths, both formats, unrecognised and broken input)
 *   MP-2 the Python probe (probe_ai_merge_drivers.py) passes against the extension's drivers registered in a
 *        scratch global git config
 *   MP-3 without the Python drivers (another machine) the TypeScript drivers still merge the probe's fixtures
 *        (both sides kept, LF)
 *   MP-4 ai-trail: a `## 🚀 PROMPT` line inside fenced code (a tool result quoting another trail) is no block:
 *        the block it sits in stays whole and in place (the fix of al_the_bear trailfence1, where the Python
 *        driver splits)
 *
 * MP-1 and MP-2 skip, saying so, where no python3 or no Python drivers are found; the yaml cases skip
 * without PyYAML.
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';

import { aiMergeDriverCliMain } from '../aiMergeDriverCli.js';
import { AI_MERGE_DRIVER_NAMES, type AiMergeDriverName } from '../aiMergeDrivers/index.js';
import { driverCommandLine } from '../aiMergeDriverSetup.js';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-merge-parity-'));
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

const SOURCES: Record<AiMergeDriverName, string> = {
    'ai-yaml-smart': 'ai_merge_yaml.py',
    'ai-block-history': 'ai_merge_block_history.py',
    'ai-trail': 'ai_merge_trail.py',
    'ai-history-json': 'ai_merge_history_json.py',
    'ai-history-md': 'ai_merge_history_md.py',
};

function findPythonDrivers(): string | undefined {
    if (process.env.TOM_AI_MERGE_DRIVERS_DIR) { return process.env.TOM_AI_MERGE_DRIVERS_DIR; }
    let dir = path.resolve(__dirname);
    for (let i = 0; i < 12; i++) {
        const cand = path.join(dir, '.claude', 'skills', '_lib', 'merge_drivers');
        if (fs.existsSync(path.join(cand, 'ai_merge_trail.py'))) { return cand; }
        const up = path.dirname(dir);
        if (up === dir) { break; }
        dir = up;
    }
    return undefined;
}
const PY_DIR = findPythonDrivers();
const PYTHON = spawnSync('python3', ['--version']).status === 0 ? 'python3' : undefined;
const PYYAML = !!PYTHON && spawnSync(PYTHON, ['-c', 'import yaml']).status === 0;
const CLI = path.join(__dirname, '..', 'aiMergeDriverCli.js');

// ── fixtures ────────────────────────────────────────────────────────────────

const block = (c: string, m: string, body: string): string => `<!-- tom:block created="${c}" modified="${m}" -->\n${body}\n<!-- /tom:block -->\n`;
const trail = (...entries: Array<[string, string]>): string => '<!-- tom-ai live-trail -->\n' + entries.map(([ts, b]) => `\n## \u{1F680} PROMPT ${ts} x\n\n${b}\n`).join('');
const summary = (...e: Array<[string, string, string, string]>): string => e.map(([k, id, ts, b]) => `=== ${k} ${id} ${ts} 1 ===\n${b}\n`).join('\n');
const hjson = (saved: string, summ: string, ...turns: Array<[string, string]>): string => JSON.stringify({ savedAt: saved, messages: { compactedSummary: summ, rawTurns: turns.map(([t, c]) => ({ role: 'user', content: c, timestamp: t })) } }, null, 2) + '\n';
const hjsonOld = (saved: string, ...contents: string[]): string => JSON.stringify({ savedAt: saved, messages: { compactedSummary: '', rawTurns: contents.map((c) => ({ role: 'user', content: c })) } }, null, 2) + '\n';
const hmd = (saved: string, summ: string, ...turns: Array<[string, string]>): string => {
    let out = `# Session history — \`probe\`\n\n_Saved at ${saved}._\n\n## Compacted summary — ${summ.length} chars\n\n${summ}\n## Raw turns — ${turns.length} messages\n\n`;
    turns.forEach(([t, c], i) => { out += `### [${i + 1}] user — ${t ? `${t} — ` : ''}${c.length} chars\n\n${c}\n\n`; });
    return out;
};
const T = ['2026-10-27T10:00:00.000Z', '2026-10-27T11:00:00.000Z', '2026-10-27T12:00:00.000Z'];

interface Case { name: string; driver: AiMergeDriverName; ours?: string; theirs?: string; ancestor?: string }

const CASES: Case[] = [
    // ai-trail
    { name: 'trail probe', driver: 'ai-trail', ancestor: trail(['20261027_100000', 'base']), ours: trail(['20261027_100000', 'base'], ['20261027_110000', 'oursentry']), theirs: trail(['20261027_100000', 'base'], ['20261027_120000', 'theirsentry']) },
    { name: 'trail interleaved, out of order', driver: 'ai-trail', ours: trail(['20261027_130000', 'c'], ['20261027_100000', 'a']), theirs: trail(['20261027_120000', 'b'], ['20261027_090000', 'z']) },
    { name: 'trail collision: longer body wins', driver: 'ai-trail', ours: trail(['20261027_100000', 'short']), theirs: trail(['20261027_100000', 'the longer body\nwith two lines']) },
    { name: 'trail collision: code points, not UTF-16', driver: 'ai-trail', ours: trail(['20261027_100000', '\u{1F680}\u{1F680}']), theirs: trail(['20261027_100000', 'abc']) },
    { name: 'trail body-less header heals', driver: 'ai-trail', ours: '<!-- tom-ai live-trail -->\n\n## \u{1F680} PROMPT 20261027_100000 x\n', theirs: trail(['20261027_100000', 'full']) },
    { name: 'trail preamble only in theirs', driver: 'ai-trail', ours: '## \u{1F680} PROMPT 20261027_100000 x\n\nours\n', theirs: '<!-- banner -->\n\n## \u{1F680} PROMPT 20261027_110000 x\n\ntheirs\n' },
    { name: 'trail summary format', driver: 'ai-trail', ours: summary(['PROMPT', 'r1', T[0], 'p1'], ['ANSWER', 'r1', T[0], 'a1']), theirs: summary(['PROMPT', 'r2', T[1], 'p2'], ['ANSWER', 'r1', T[0], 'a1 longer']) },
    { name: 'trail CRLF lines', driver: 'ai-trail', ours: trail(['20261027_100000', 'a']).replace(/\n/g, '\r\n'), theirs: trail(['20261027_110000', 'b']) },
    { name: 'trail unrecognised', driver: 'ai-trail', ours: 'just text\n', theirs: 'other text\n' },
    { name: 'trail ours empty', driver: 'ai-trail', ours: '', theirs: trail(['20261027_100000', 't']) },
    { name: 'trail theirs empty', driver: 'ai-trail', ours: trail(['20261027_100000', 'o']), theirs: '  \n' },
    { name: 'trail both missing', driver: 'ai-trail' },
    // ai-block-history
    { name: 'block probe', driver: 'ai-block-history', ancestor: block('2026-10-01', '2026-10-01', 'base'), ours: block('2026-10-01', '2026-10-01', 'base') + block('2026-10-02', '2026-10-02', 'oursentry'), theirs: block('2026-10-01', '2026-10-01', 'base') + block('2026-10-03', '2026-10-03', 'theirsentry') },
    { name: 'block collision: newer modified wins', driver: 'ai-block-history', ours: block('2026-10-01', '2026-10-05', 'ours newer'), theirs: block('2026-10-01', '2026-10-02', 'theirs older') + '\n\n' + block('2026-09-01', '2026-09-01', 'first') },
    { name: 'block unterminated', driver: 'ai-block-history', ours: '<!-- tom:block created="a" modified="b" -->\nbody\n', theirs: block('x', 'y', 'z') },
    { name: 'block both empty', driver: 'ai-block-history', ours: '', theirs: '' },
    { name: 'block surrounding text dropped', driver: 'ai-block-history', ours: 'intro\n' + block('2026-10-01', '2026-10-01', '\n\nspaced\n\n'), theirs: block('2026-10-02', '2026-10-02', 'é ü \u{1F680}') },
    // ai-history-json
    { name: 'json probe', driver: 'ai-history-json', ours: hjson(T[0], '', [T[0], 'base'], [T[1], 'oursentry']), theirs: hjson(T[0], '', [T[0], 'base'], [T[2], 'theirsentry']) },
    { name: 'json collision and summaries', driver: 'ai-history-json', ours: hjson(T[1], 'ours summary', [T[0], 'short'], [T[2], 'c']), theirs: hjson(T[2], 'theirs summary', [T[0], 'the longer one'], [T[1], 'b \u{1F680}']) },
    { name: 'json only ours new', driver: 'ai-history-json', ours: hjson(T[0], '', [T[0], 'new']), theirs: hjsonOld(T[1], 'old') },
    { name: 'json only theirs new', driver: 'ai-history-json', ours: hjsonOld(T[1], 'old'), theirs: hjson(T[0], 'x', [T[0], 'new']) },
    { name: 'json both old', driver: 'ai-history-json', ours: hjsonOld(T[0], 'a'), theirs: hjsonOld(T[1], 'b') },
    { name: 'json one side missing summary', driver: 'ai-history-json', ours: hjson('', '', [T[0], 'a']), theirs: hjson(T[1], 'only theirs', [T[1], 'b']) },
    { name: 'json invalid ours', driver: 'ai-history-json', ours: '{ not json', theirs: hjson(T[0], '', [T[0], 'b']) },
    { name: 'json unicode content', driver: 'ai-history-json', ours: hjson(T[0], 'ä', [T[0], 'naïve — “quotes” \u{1F680}\ttab\u0001']), theirs: hjson(T[1], '', [T[1], 'line\nbreak \\ backslash / slash']) },
    // ai-history-md
    { name: 'md probe', driver: 'ai-history-md', ours: hmd(T[0], '', [T[0], 'base'], [T[1], 'oursentry']), theirs: hmd(T[0], '', [T[0], 'base'], [T[2], 'theirsentry']) },
    { name: 'md collision, summaries, newer meta', driver: 'ai-history-md', ours: hmd(T[1], 'ours sum', [T[0], 'short'], [T[2], 'c \u{1F680}\u{1F680}']), theirs: hmd(T[2], 'theirs sum', [T[0], 'longer body here'], [T[1], 'b']) },
    { name: 'md only theirs new', driver: 'ai-history-md', ours: hmd(T[0], '', ['', 'old']), theirs: hmd(T[1], '', [T[1], 'new']) },
    { name: 'md both old', driver: 'ai-history-md', ours: hmd(T[0], '', ['', 'a']), theirs: hmd(T[1], '', ['', 'b']) },
    { name: 'md CRLF and odd line breaks', driver: 'ai-history-md', ours: hmd(T[0], 's', [T[0], 'a b']).replace(/\n/g, '\r\n'), theirs: hmd(T[1], '', [T[1], 'c\fd']) },
    { name: 'md ours blank', driver: 'ai-history-md', ours: '\n', theirs: hmd(T[0], '', [T[0], 'x']) },
    // ai-yaml-smart
    { name: 'yaml probe', driver: 'ai-yaml-smart', ancestor: 'todos:\n  - {id: base, updated: x}\n', ours: 'todos:\n  - {id: base, updated: x}\n  - {id: oursentry, updated: y}\n', theirs: 'todos:\n  - {id: base, updated: x}\n  - {id: theirsentry, updated: z}\n' },
    { name: 'yaml todo file collisions by updated', driver: 'ai-yaml-smart', ours: 'todos:\n- id: a\n  title: ours a\n  updated: 2026-10-02\n- id: b\n  title: ours b\n  updated: 2026-10-05\n- id: c\n  title: only ours\n', theirs: 'todos:\n- id: b\n  title: theirs b\n  updated: 2026-10-04\n- id: a\n  title: theirs a\n  updated: 2026-10-03\n- id: d\n  title: only theirs\n- title: no id\n' },
    { name: 'yaml timestamps (PyYAML rewrites them)', driver: 'ai-yaml-smart', ours: `todos:\n  - {id: base, updated: ${T[0]}}\n  - {id: o, updated: ${T[1]}}\n`, theirs: `todos:\n  - {id: base, updated: ${T[2]}}\n  - {id: t, updated: ${T[2]}}\n` },
    { name: 'yaml top-level keys by updated', driver: 'ai-yaml-smart', ours: 'a: {v: 1, updated: "2026-01-02"}\nb: {v: ours}\nkeep: 1\n', theirs: 'a: {v: 2, updated: "2026-01-03"}\nb: {v: theirs}\nnew: [1, 2]\n' },
    { name: 'yaml top-level list', driver: 'ai-yaml-smart', ours: '- {id: 1, v: o}\n- plain\n', theirs: '- {id: 1, v: t, updated: z}\n- {id: 2}\n' },
    { name: 'yaml mismatched shapes', driver: 'ai-yaml-smart', ours: 'a: 1\n', theirs: '- 1\n' },
    { name: 'yaml invalid', driver: 'ai-yaml-smart', ours: 'a: [1\n', theirs: 'a: 1\n' },
    { name: 'yaml ours empty', driver: 'ai-yaml-smart', ours: '', theirs: 'a: 1\n' },
    { name: 'yaml unicode and multiline', driver: 'ai-yaml-smart', ours: 'todos:\n- id: u\n  description: |-\n    Zeile 1 — ä\n    line 2 \u{1F680}\n', theirs: 'todos:\n- id: v\n  title: "quoted: colon"\n' },
];

// ── running ─────────────────────────────────────────────────────────────────

let n = 0;
function files(c: Case): { O: string; A: string; B: string; P: string } {
    const dir = path.join(SANDBOX, String(n++));
    fs.mkdirSync(dir);
    const put = (name: string, text: string | undefined): string => {
        const p = path.join(dir, name);
        if (text !== undefined) { fs.writeFileSync(p, text, 'utf8'); }
        return p;
    };
    return { O: put('O', c.ancestor ?? ''), A: put('A', c.ours), B: put('B', c.theirs), P: 'display.file' };
}
const readOr = (p: string): string | undefined => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined);

function runPython(c: Case): { code: number; out: string | undefined } {
    const f = files(c);
    const r = spawnSync(PYTHON!, [path.join(PY_DIR!, SOURCES[c.driver]), f.O, f.A, f.B, '7', f.P], { encoding: 'utf8' });
    return { code: r.status ?? -1, out: readOr(f.A) };
}
function runTs(c: Case): { code: number; out: string | undefined } {
    const f = files(c);
    const code = aiMergeDriverCliMain([c.driver, f.O, f.A, f.B, '7', f.P], () => undefined);
    return { code, out: readOr(f.A) };
}
/** As YAML 1.1 reads it (timestamps as dates, both drivers' forms alike). */
const yaml11 = (text: string | undefined): string => JSON.stringify(text === undefined ? null : parse(text, { version: '1.1' }) ?? null);

describe('the _ai merge drivers in TypeScript', () => {
    test('MP-1: the same results as the Python drivers', (t) => {
        if (!PYTHON || !PY_DIR) { t.skip(`no ${PYTHON ? 'Python drivers above this checkout (TOM_AI_MERGE_DRIVERS_DIR)' : 'python3'}`); return; }
        let compared = 0;
        for (const c of CASES) {
            if (c.driver === 'ai-yaml-smart' && !PYYAML) { continue; }
            const py = runPython(c);
            const ts = runTs(c);
            assert.equal(ts.code, py.code, `${c.name}: exit code`);
            if (c.driver === 'ai-yaml-smart' && py.code === 0) {
                assert.equal(yaml11(ts.out), yaml11(py.out), `${c.name}: the merged values`);
            } else {
                assert.equal(ts.out, py.out, `${c.name}: %A afterwards`);
            }
            if (ts.out !== undefined) { assert.ok(!ts.out.includes('\r') || (c.ours ?? '').includes('\r'), `${c.name}: no CR added`); }
            compared++;
        }
        assert.ok(compared >= CASES.length - (PYYAML ? 0 : 9), `${compared} cases compared`);
    });

    test('MP-2: the Python probe passes against the extension\'s drivers', (t) => {
        if (!PYTHON || !PY_DIR) { t.skip('no python3 or no Python drivers'); return; }
        const cfg = path.join(SANDBOX, 'gitconfig');
        fs.writeFileSync(cfg, '');
        const env = { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' };
        for (const d of AI_MERGE_DRIVER_NAMES) {
            execFileSync('git', ['config', '--global', `merge.${d}.driver`, driverCommandLine(d, CLI, `"${process.execPath}"`)], { env });
        }
        const r = spawnSync(PYTHON, [path.join(PY_DIR, 'probe_ai_merge_drivers.py')], { env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal((r.stdout.match(/^OK /gm) ?? []).length, 5, r.stdout);
    });

    test('MP-3: the probe fixtures without Python', () => {
        for (const c of CASES.filter((x) => x.name.endsWith(' probe'))) {
            const r = runTs(c);
            assert.equal(r.code, 0, c.name);
            for (const w of ['base', 'oursentry', 'theirsentry']) { assert.ok(r.out!.includes(w), `${c.name} keeps ${w}`); }
            assert.ok(!r.out!.includes('\r'), `${c.name}: LF`);
        }
    });
    test('MP-4: ai-trail and quoted headers in fenced code', () => {
        const quoting = '\n## \u{1F680} PROMPT 20261117_100000 x\n\nread another trail:\n\n````text\n## \u{1F680} PROMPT 20200101_000000 old\n\n```json\n{}\n```\n````\n\nafter the fence\n';
        const ours = '<!-- tom-ai live-trail -->\n' + quoting;
        const theirs = '<!-- tom-ai live-trail -->\n\n## \u{1F680} PROMPT 20261117_110000 x\n\ntheirs\n';
        const r = runTs({ name: 'fence', driver: 'ai-trail', ours, theirs });
        assert.equal(r.code, 0);
        assert.equal(r.out, '<!-- tom-ai live-trail -->\n' + quoting + '\n## \u{1F680} PROMPT 20261117_110000 x\n\ntheirs\n');
        assert.equal((r.out!.match(/^## \u{1F680} PROMPT 2020/gmu) ?? []).length, 1, 'the quoted header stays inside its block');
    });
});
