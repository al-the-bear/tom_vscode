/**
 * The compact trail's limit (src/utils/compactTrailTrim.ts): `trail.compact.maxEntries` (default 2000) turns per
 * summary trail file (`<quest>.<subsystem>.prompts.md` / `.answers.md`), applied by every writer.
 *
 *   CTL-1 the trim counts turns (distinct request ids; a turn written twice counts once), keeps the newest and drops
 *         every older entry at once, however far the text is over the limit; a body line that is no full header is
 *         not an entry; within the limit nothing changes
 *   CTL-2 the setting: `trail.compact.maxEntries`, default 2000; `trail.raw.maxEntries` does not limit the compact
 *         trail; an invalid value falls back to the default
 *   CTL-3 TrailService.writeSummaryPrompt / writeSummaryAnswer: a file far over the limit (an older build's, 1,774
 *         entries against 1,000) is back at the limit after one write, the new entry on top; without a setting the
 *         default 2000 holds
 *   CTL-4 the transports' writer paths: the local LLM / LM API logging (logPrompt, logResponse, writeTrailFile)
 *         keeps the limit; the other writer of the pair (the Anthropic handler) writes through TrailService, and no
 *         other source file writes a compact trail header or trims one its own way
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
import {
    COMPACT_TRAIL_DEFAULT_MAX_ENTRIES,
    compactTrailMaxEntries,
    countCompactTrailTurns,
    trimCompactTrailContent,
} from '../../utils/compactTrailTrim.js';

let trailConfig: unknown = {};
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-trail-'));

installVscodeStub({
    workspaceFolders: [tmpRoot],
    moduleOverrides: {
        '../utils/tomAiConfiguration': {
            TomAiConfiguration: { instance: { getTrail: (): unknown => trailConfig } },
        },
    },
});

/** A compact trail text of `n` turns, newest (highest sequence) first. */
function trailText(kind: 'PROMPT' | 'ANSWER', n: number, from = 1): string {
    const out: string[] = [];
    for (let seq = from + n - 1; seq >= from; seq--) {
        out.push(`=== ${kind} id${seq}_x 2026-11-20T10:00:00.000Z ${seq} ===\n\nbody ${seq}\n\n`);
    }
    return out.join('');
}

const SRC = path.join(__dirname, '..', '..', '..', 'src');

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') { out.push(...sourceFiles(p)); } } else if (e.name.endsWith('.ts')) { out.push(p); }
    }
    return out;
}

describe('the compact trail limit', () => {
    test('CTL-1: the trim', () => {
        const text = trailText('PROMPT', 10);
        assert.equal(countCompactTrailTurns(text), 10);
        const trimmed = trimCompactTrailContent(text, 3)!;
        assert.equal(countCompactTrailTurns(trimmed), 3, 'every entry beyond the limit dropped at once');
        assert.match(trimmed, /^=== PROMPT id10_x /, 'the newest kept');
        assert.ok(trimmed.includes('body 8') && !trimmed.includes('body 7'));
        assert.equal(trimCompactTrailContent(text, 10), undefined, 'within the limit: unchanged');
        // A turn written twice (an answer after an error) counts once.
        const twice = '=== ANSWER a 2026-11-20T10:00:02Z 3 ===\n\nretry\n\n=== ANSWER a 2026-11-20T10:00:01Z 2 ===\n\n(error)\n\n=== ANSWER b 2026-11-20T10:00:00Z 1 ===\n\nold\n';
        assert.equal(countCompactTrailTurns(twice), 2);
        assert.equal(trimCompactTrailContent(twice, 2), undefined);
        assert.equal(trimCompactTrailContent(twice, 1), '=== ANSWER a 2026-11-20T10:00:02Z 3 ===\n\nretry\n\n=== ANSWER a 2026-11-20T10:00:01Z 2 ===\n\n(error)\n');
        // A body line that is no full header is no entry.
        const quoted = '=== PROMPT p2 2026-11-20T10:00:01Z 2 ===\n\n=== PROMPT and the rest of a quoted line\n\n=== PROMPT p1 2026-11-20T10:00:00Z 1 ===\n\nx\n';
        assert.equal(countCompactTrailTurns(quoted), 2);
        assert.equal(trimCompactTrailContent(quoted, 1), '=== PROMPT p2 2026-11-20T10:00:01Z 2 ===\n\n=== PROMPT and the rest of a quoted line\n');
    });

    test('CTL-2: the setting', () => {
        assert.equal(COMPACT_TRAIL_DEFAULT_MAX_ENTRIES, 2000);
        assert.equal(compactTrailMaxEntries(undefined), 2000);
        assert.equal(compactTrailMaxEntries({ raw: { maxEntries: 1000 } }), 2000, 'trail.raw.maxEntries does not limit it');
        assert.equal(compactTrailMaxEntries({ maxEntries: 1000 }), 2000, 'nor the flat key of older builds');
        assert.equal(compactTrailMaxEntries({ compact: { maxEntries: 500 } }), 500);
        assert.equal(compactTrailMaxEntries({ compact: { maxEntries: 0 } }), 2000);
        assert.equal(compactTrailMaxEntries({ compact: { maxEntries: '300' } }), 2000);
        const schema = JSON.parse(fs.readFileSync(path.join(SRC, 'config', 'tom_vscode_extension.schema.json'), 'utf8'));
        assert.equal(schema.properties.trail.properties.compact.properties.maxEntries.default, 2000);
        assert.match(fs.readFileSync(path.join(SRC, 'utils', 'sendToChatConfig.ts'), 'utf8'), /compact\?: \{\s*\n\s*\/\*\*[^\n]*\*\/\s*\n\s*maxEntries\?: number;/);
    });

    test('CTL-3: TrailService keeps the limit on both files', async () => {
        const { TrailService } = await import('../trailService.js');
        const { ANTHROPIC_SUBSYSTEM } = await import('../trailSubsystems.js');
        TrailService.init({} as never);
        const svc = TrailService.instance;

        trailConfig = { raw: { maxEntries: 1000 }, compact: { maxEntries: 1000 } };
        const prompts = svc.getSummaryFilePath('prompts', ANTHROPIC_SUBSYSTEM, 'q1')!;
        const answers = svc.getSummaryFilePath('answers', ANTHROPIC_SUBSYSTEM, 'q1')!;
        fs.mkdirSync(path.dirname(prompts), { recursive: true });
        fs.writeFileSync(prompts, trailText('PROMPT', 1774, 393));
        fs.writeFileSync(answers, trailText('ANSWER', 1500));
        svc.writeSummaryPrompt(ANTHROPIC_SUBSYSTEM, 'the new prompt\n\nREQUEST-ID: newreq_1', 'q1');
        svc.writeSummaryAnswer(ANTHROPIC_SUBSYSTEM, 'the new answer', { requestId: 'newreq_1' }, 'q1');
        for (const file of [prompts, answers]) {
            const body = fs.readFileSync(file, 'utf8');
            assert.equal(countCompactTrailTurns(body), 1000, `${path.basename(file)} back at the limit after one write`);
            assert.match(body, /^=== (PROMPT|ANSWER) newreq_1 /, 'the new entry on top');
        }

        trailConfig = {};
        const p2 = svc.getSummaryFilePath('prompts', ANTHROPIC_SUBSYSTEM, 'q2')!;
        fs.mkdirSync(path.dirname(p2), { recursive: true });
        fs.writeFileSync(p2, trailText('PROMPT', 2005));
        svc.writeSummaryPrompt(ANTHROPIC_SUBSYSTEM, 'next', 'q2');
        assert.equal(countCompactTrailTurns(fs.readFileSync(p2, 'utf8')), 2000, 'the default 2000');
    });

    test('CTL-4: the transports keep the limit', async () => {
        const { TrailService } = await import('../trailService.js');
        const logging = await import('../trailLogging.js');
        TrailService.init({} as never);
        const svc = TrailService.instance;
        trailConfig = { compact: { maxEntries: 5 } };

        const seed = (subsystem: Parameters<typeof svc.getSummaryFilePath>[1], quest: string): { prompts: string; answers: string } => {
            const prompts = svc.getSummaryFilePath('prompts', subsystem, quest)!;
            const answers = svc.getSummaryFilePath('answers', subsystem, quest)!;
            fs.mkdirSync(path.dirname(prompts), { recursive: true });
            fs.writeFileSync(prompts, trailText('PROMPT', 40));
            fs.writeFileSync(answers, trailText('ANSWER', 40));
            return { prompts, answers };
        };
        const turns = (file: string): number => countCompactTrailTurns(fs.readFileSync(file, 'utf8'));

        // Local LLM (logPrompt / logResponse).
        const local = seed({ type: 'localLlm', configName: 'gemma' }, 'ql');
        logging.logPrompt('local', 'gemma', 'a prompt', undefined, { questId: 'ql', requestId: 'r1' });
        logging.logResponse('local', 'gemma', 'an answer', true, { questId: 'ql', requestId: 'r1' });
        assert.deepEqual([turns(local.prompts), turns(local.answers)], [5, 5], 'local LLM');

        // writeTrailFile (the scripting bridge's trail writes).
        const scripted = seed({ type: 'localLlm', configName: 'default' }, 'qs');
        await logging.writeTrailFile('x.prompt.md', 'p', 'local', 'default', { questId: 'qs' });
        await logging.writeTrailFile('x.answer.md', 'a', 'local', 'default', { questId: 'qs' });
        assert.deepEqual([turns(scripted.prompts), turns(scripted.answers)], [5, 5], 'writeTrailFile');

        // The other writers go through TrailService; nothing else writes or trims a compact trail.
        const writers = new Map<string, number>();
        for (const file of sourceFiles(SRC)) {
            const text = fs.readFileSync(file, 'utf8');
            const rel = path.relative(SRC, file).split(path.sep).join('/');
            const calls = (text.match(/\.writeSummary(?:Prompt|Answer)\(/g) ?? []).length;
            if (calls > 0 && rel !== 'services/trailService.ts') { writers.set(rel, calls); }
            if (rel !== 'services/trailService.ts') {
                assert.doesNotMatch(text, /=== (?:PROMPT|ANSWER) \$\{/, `${rel} writes no compact trail header of its own`);
            }
            if (rel !== 'utils/compactTrailTrim.ts') {
                assert.doesNotMatch(text, /function trim\w*TrailFile|trimTrailFile\(/, `${rel} has no trim of its own`);
            }
        }
        for (const rel of ['handlers/anthropic-handler.ts', 'services/trailLogging.ts']) {
            assert.ok(writers.has(rel), `${rel} writes through TrailService`);
        }
        const service = fs.readFileSync(path.join(SRC, 'services', 'trailService.ts'), 'utf8');
        assert.equal((service.match(/this\.prependEntry\(target, entry\);\n\s*trimCompactTrailFile\(target, this\.getMaxSummaryEntries\(\)\);/g) ?? []).length, 2,
            'both writes trim after prepending');
        assert.match(service, /compactTrailMaxEntries\(TomAiConfiguration\.instance\.getTrail\(\)\)/);
    });
});
